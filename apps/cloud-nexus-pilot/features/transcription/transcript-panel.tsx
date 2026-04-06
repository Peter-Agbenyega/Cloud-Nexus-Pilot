"use client";

import { TranscriptionRuntimeSurface } from "@/features/transcription/transcription-runtime-surface";
import { useTranscriptionWorkflow } from "@/features/transcription/use-transcription-workflow";

export function TranscriptPanel() {
  const workflow = useTranscriptionWorkflow();

  return <TranscriptionRuntimeSurface workflow={workflow} variant="standalone" />;
}
