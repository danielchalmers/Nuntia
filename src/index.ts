import * as core from '@actions/core';
import { getConfig } from './env';
import { GitHubClient } from './github';
import { buildReleaseContext } from './context';
import { buildPrompt } from './prompt';
import { buildTextPayload, GeminiClient } from './gemini';
import { writeTextFile } from './storage';
import { uploadArtifact } from './artifacts';

async function run(): Promise<void> {
  const cfg = getConfig();
  const gh = new GitHubClient(cfg.token, cfg.owner, cfg.repo);
  const gemini = new GeminiClient(cfg.geminiApiKey);

  console.log(`🧭 Nuntia generating release notes for ${cfg.owner}/${cfg.repo}`);
  console.log(`🔗 Range: ${cfg.baseCommit}..${cfg.headCommit} on ${cfg.branch}`);

  const context = await buildReleaseContext(cfg, gh);
  console.log(`📦 Commit range resolved: ${context.commits.length} commit(s), ${context.linkedItems.length} linked item(s).`);

  const { systemPrompt, userPrompt } = buildPrompt(context, cfg.promptPath);
  const payload = buildTextPayload(systemPrompt, userPrompt, cfg.model, cfg.temperature);

  console.log(`✨ Generating release notes with ${cfg.model} (temp ${cfg.temperature})...`);
  const { text, inputTokens, outputTokens } = await gemini.generateText(payload, 2, 5000);

  const outputPath = writeTextFile(cfg.outputPath, text);
  await uploadArtifact(cfg.artifactName, outputPath);

  core.setOutput('release-notes-path', outputPath);
  core.setOutput('release-notes-artifact', cfg.artifactName);
  core.setOutput('input-tokens', String(inputTokens));
  core.setOutput('output-tokens', String(outputTokens));

  console.log(`✅ Release notes saved to ${outputPath} and uploaded as artifact '${cfg.artifactName}'.`);
}

run().catch(err => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
