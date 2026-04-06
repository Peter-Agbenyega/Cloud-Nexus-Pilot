import { PromptVault } from "@/components/prompt-vault";
import { PageHero } from "@/components/page-hero";

export default function PromptLibraryPage() {
  return (
    <>
      <PageHero
        eyebrow="Prompt Vault"
        title="Turn your best prompts into a reusable operating system."
        description="Cloud Nexus Pilot now includes a local-first Prompt Vault for saving, editing, cloning, and activating prompts across interview and meeting workflows."
      />
      <PromptVault />
    </>
  );
}
