#!/usr/bin/env python3
"""Check release-record structure and local artifact integrity; never run or deploy.

Schema 2 binds every gate to the complete release source vector. Evidence is not
self-authenticating: a successful check grants no release approval and does not
prove a human or CI runner truthfully generated the records. Use an immutable,
reviewed evidence directory and independently selected revisions.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any

COMMON = (
    'clean_install', 'dependency_audit', 'lint', 'typecheck', 'unit_tests',
    'production_build', 'database_migrations', 'staging_auth', 'tenant_isolation',
    'backup_restore', 'rollback', 'deployment_mapping',
)
REQUIRED = {
    'apply': COMMON + ('worker_clean_install', 'worker_dependency_audit',
                      'worker_tests', 'browser_fixtures', 'approval_invalidation',
                      'duplicate_recovery', 'authorized_workflow'),
    'pilot': COMMON + ('api_lint', 'api_typecheck', 'api_tests', 'api_auth_cost_guard',
                      'audio_browser_journey', 'provider_contract',
                      'multiinstance_reconnect', 'long_session'),
}
SHA = re.compile(r'^[0-9a-f]{40}(?:[0-9a-f]{24})?$')
DIGEST = re.compile(r'^[0-9a-f]{64}$')
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_ARTIFACT_BYTES = 64 * 1024 * 1024


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'duplicate JSON key: {key}')
        result[key] = value
    return result


def reject_constant(value: str) -> None:
    raise ValueError(f'non-finite JSON number: {value}')


def read_manifest(path: Path) -> Any:
    if not path.is_file() or path.stat().st_size > MAX_MANIFEST_BYTES:
        raise ValueError('manifest must be a regular file no larger than 1 MiB')
    return json.loads(path.read_text(encoding='utf-8'),
                      object_pairs_hook=unique_object, parse_constant=reject_constant)


def valid_time(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.tzinfo is not None
    except ValueError:
        return False


def artifact_error(record: Any, root: Path) -> str | None:
    if not isinstance(record, dict):
        return 'artifact must be an object'
    name, digest = record.get('path'), record.get('sha256')
    if (not isinstance(name, str) or not name or '\\' in name or ':' in name
            or PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts):
        return 'artifact requires a relative POSIX path without traversal'
    if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
        return 'artifact SHA-256 missing or malformed'
    try:
        candidate = root / name
        # Reject all symlinks, including intermediate directory links.
        for item in [candidate, *candidate.parents]:
            if item == root:
                break
            if item.is_symlink():
                return 'symlinks are not accepted as evidence'
        path = candidate.resolve(strict=True)
        path.relative_to(root)
        if not path.is_file() or not 0 < path.stat().st_size <= MAX_ARTIFACT_BYTES:
            return 'artifact must be nonempty and at most 64 MiB'
        h = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(chunk)
        if h.hexdigest() != digest:
            return 'artifact hash mismatch'
    except (OSError, ValueError):
        return 'artifact is missing, inaccessible, or outside the evidence root'
    return None


def validate(manifest: Any, root: Path, product: str,
             expected_sha: str, expected_worker_sha: str | None = None) -> list[str]:
    if product not in REQUIRED:
        return ['unknown product']
    expected = {'app': expected_sha, 'worker': expected_worker_sha} if product == 'apply' else {'pilot': expected_sha}
    if product == 'pilot' and expected_worker_sha is not None:
        return ['Pilot has no worker revision argument']
    if any(not isinstance(v, str) or not SHA.fullmatch(v) for v in expected.values()):
        return ['each independently selected source must be a lowercase Git object ID; Apply requires its worker SHA']
    if not isinstance(manifest, dict):
        return ['manifest must be a JSON object']
    errors: list[str] = []
    if type(manifest.get('schema_version')) is not int or manifest['schema_version'] != 2:
        errors.append('schema_version must be integer 2; schema 1 is not silently promoted')
    if manifest.get('product') != product:
        errors.append('product mismatch')
    if manifest.get('sources') != expected:
        errors.append('release source vector mismatch')
    if manifest.get('blockers') != []:
        errors.append('blockers must explicitly be an empty list')
    stages = manifest.get('stages')
    if not isinstance(stages, dict):
        return errors + ['stages must be an object']
    root = root.resolve()
    if not root.is_dir():
        return errors + ['evidence root must be an existing directory']
    for name in REQUIRED[product]:
        stage = stages.get(name)
        if not isinstance(stage, dict):
            errors.append(f'{name}: missing record')
            continue
        if stage.get('status') != 'passed':
            errors.append(f'{name}: must be passed; pending/skipped/failed cannot pass')
        if stage.get('sources') != expected:
            errors.append(f'{name}: stale or incomplete source vector')
        if not valid_time(stage.get('executed_at')):
            errors.append(f'{name}: executed_at requires an ISO timestamp with timezone')
        if not isinstance(stage.get('summary'), str) or not stage['summary'].strip():
            errors.append(f'{name}: meaningful result summary required')
        kind = stage.get('kind')
        if kind not in ('command', 'exercise', 'review'):
            errors.append(f'{name}: kind must be command, exercise, or review')
        elif kind == 'command':
            command = stage.get('command')
            if not isinstance(command, list) or not command or not all(isinstance(v, str) and v for v in command):
                errors.append(f'{name}: command must be a nonempty argument list')
            if type(stage.get('exit_code')) is not int or stage['exit_code'] != 0:
                errors.append(f'{name}: passed command requires integer exit code 0')
        elif not isinstance(stage.get('reviewer'), str) or not stage['reviewer'].strip():
            errors.append(f'{name}: exercise/review requires reviewer identity')
        artifacts = stage.get('artifacts')
        if not isinstance(artifacts, list) or not artifacts:
            errors.append(f'{name}: at least one artifact required')
        else:
            for item in artifacts:
                problem = artifact_error(item, root)
                if problem:
                    errors.append(f'{name}: {problem}')
        if name.endswith('dependency_audit'):
            unresolved = stage.get('unresolved_high_critical')
            if type(unresolved) is not int or unresolved != 0:
                errors.append(f'{name}: unresolved high/critical findings block release')
            if not valid_time(stage.get('advisories_checked_at')):
                errors.append(f'{name}: advisory-check timestamp required')
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--evidence-root', required=True, type=Path)
    parser.add_argument('--product', choices=tuple(REQUIRED), required=True)
    parser.add_argument('--expected-sha', required=True)
    parser.add_argument('--expected-worker-sha')
    args = parser.parse_args()
    try:
        errors = validate(read_manifest(args.manifest), args.evidence_root,
                          args.product, args.expected_sha, args.expected_worker_sha)
    except (OSError, ValueError, TypeError, RecursionError) as exc:
        print(json.dumps({'result': 'BLOCKED', 'errors': [str(exc)],
                          'release_authorization_granted': False}))
        return 2
    print(json.dumps({'result': 'BLOCKED' if errors else 'EVIDENCE_STRUCTURALLY_VALID',
                      'errors': errors, 'release_authorization_granted': False}, indent=2))
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
