// Keep configuration bootstrap messages out of the machine-readable stdout channel.
process.env.DOTENV_CONFIG_QUIET = 'true';
import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { BlueprintSpecSchema } from '../blueprint/schema/blueprintSpec';
import { ApproverRegistrySchema, REGISTRY_PATH } from '../blueprint/approvals';
import { validateBlueprint } from '../blueprint/validate';
import { exportBlueprint } from '../blueprint/export/exportBlueprint';
import { deriveAttestations, githubApi, publishStatus, HeadMovedError } from '../blueprint/githubReviews';
import { isBlueprintPath } from '../blueprint/freshness';
import { renderQuestionnaire } from '../blueprint/questionnaire';
import { Logger } from '../utils/Logger';

const ROOT = path.resolve(__dirname, '../..');
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
class UsageError extends Error {}
function argumentsFor(argv: string[]): { command: string; file?: string; flags: Record<string, string> } {
  const [command, ...rest] = argv; const allowed: Record<string, string[]> = {
    validate: [], export: ['out'], questionnaire: ['out'], 'verify-and-validate': ['pull', 'head'],
  };
  if (!Object.prototype.hasOwnProperty.call(allowed, command ?? '')) throw new UsageError('Expected validate, export, questionnaire or verify-and-validate');
  const flags: Record<string, string> = {}; let file: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const flag = arg.slice(2); const value = rest[++i];
      if (!allowed[command].includes(flag) || flag in flags || !value || value.startsWith('--')) throw new UsageError(`Invalid option ${arg}`);
      flags[flag] = value;
    } else if (file || !['validate', 'export'].includes(command)) throw new UsageError('Unexpected positional argument');
    else file = arg;
  }
  if (['validate', 'export'].includes(command) && (!file || !fs.existsSync(file) || !fs.statSync(file).isFile())) throw new UsageError('Blueprint file is required and must exist');
  if (command === 'export' && !flags.out) throw new UsageError('export requires --out');
  return { command, file, flags };
}

export async function main(argv: string[]): Promise<number> {
  try {
    const { command, file, flags } = argumentsFor(argv);
    if (command === 'questionnaire') {
      if (flags.out) fs.writeFileSync(flags.out, renderQuestionnaire()); else process.stdout.write(renderQuestionnaire());
      return 0;
    }
    const logger = new Logger('Blueprint'); logger.setLevel('silent');
    const registryBytes = fs.readFileSync(path.join(ROOT, REGISTRY_PATH), 'utf8');
    const registry = ApproverRegistrySchema.parse(JSON.parse(registryBytes));
    if (command !== 'verify-and-validate') {
      const raw: unknown = JSON.parse(fs.readFileSync(file as string, 'utf8'));
      const validation = await validateBlueprint(raw, { registry, logger });
      if (command === 'validate') { console.log(JSON.stringify(validation, null, 2)); return validation.ok ? 0 : 1; }
      if (!validation.ok) { console.error(JSON.stringify(validation)); return 1; }
      const spec = BlueprintSpecSchema.parse(raw);
      const artifacts = exportBlueprint(spec, validation, [], {
        contentHash: validation.hash ?? '', headSha: 'local', reviewStateHash: null,
        registryHash: sha(registryBytes), derivedAt: new Date().toISOString(),
      }, null);
      fs.mkdirSync(flags.out, { recursive: true });
      for (const [name, bytes] of Object.entries(artifacts)) fs.writeFileSync(path.join(flags.out, name), bytes + '\n');
      console.log(JSON.stringify(validation, null, 2)); return 0;
    }
    const token = process.env.GITHUB_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    if (!token || !repository || !/^[^/]+\/[^/]+$/.test(repository) || !/^[1-9]\d*$/.test(flags.pull ?? '') || !/^[0-9a-f]{40}$/.test(flags.head ?? '')) {
      throw new UsageError('verify-and-validate requires GITHUB_TOKEN, GITHUB_REPOSITORY, --pull and a full --head SHA');
    }
    const [owner, repo] = repository.split('/'); const pullNumber = Number(flags.pull); const head = flags.head;
    if (!Number.isSafeInteger(pullNumber)) throw new UsageError('Invalid pull number');
    const api = githubApi(token, owner, repo, pullNumber);
    const pull = await api.getPull();
    if (pull.head.sha !== head) throw new HeadMovedError(head, pull.head.sha);
    const files = (await api.listFiles()).filter(f => isBlueprintPath(f.filename));
    let valid = true; let description = 'no blueprint changes';
    const summaries: string[] = [];
    const envelopes: string[] = [];
    if (files.length && pull.head.repo?.full_name !== repository) {
      valid = false; description = 'blueprints from forks are not verified';
    } else if (files.length) {
      // Only same-repository Blueprint validation consumes local PR data.
      const dataRoot = path.join(process.cwd(), 'pr');
      const actual = execFileSync('git', ['-C', dataRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      if (actual !== head) throw new HeadMovedError(head, actual);
      description = 'structurally valid blueprint drafts';
      for (const entry of files) {
        if (entry.status === 'removed') continue;
        // Read the committed blob, not the worktree filesystem: symlinks and filters cannot redirect this read.
        const bytes = execFileSync('git', ['-C', dataRoot, 'show', `${head}:${entry.filename}`], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
        let raw: unknown;
        try { raw = JSON.parse(bytes); } catch { valid = false; console.error(`Invalid JSON: ${entry.filename}`); continue; }
        const parsed = BlueprintSpecSchema.safeParse(raw);
        if (!parsed.success) { valid = false; console.error(`Invalid Blueprint schema: ${entry.filename}`); continue; }
        const derived = await deriveAttestations({ owner, repo, pullNumber, headSha: head, registry, spec: parsed.data, api });
        const validation = await validateBlueprint(parsed.data, { registry, attestations: derived.attestations, logger });
        if (!validation.ok) { valid = false; console.error(JSON.stringify(validation)); continue; }
        const out = exportBlueprint(parsed.data, validation, derived.attestations.items, {
          contentHash: validation.hash ?? '', headSha: head, reviewStateHash: derived.reviewStateHash,
          registryHash: sha(registryBytes), derivedAt: new Date().toISOString(),
        }, { owner, repo, pullNumber, path: entry.filename });
        envelopes.push(out['blueprint.export.json']);
        summaries.push(`${entry.filename}: executable: ${validation.executable}`);
      }
      if (!valid) description = 'invalid blueprint draft';
    }
    const finalPull = await api.getPull();
    if (finalPull.head.sha !== head) throw new HeadMovedError(head, finalPull.head.sha);
    await publishStatus(token, owner, repo, head, valid ? 'success' : 'failure', description);
    for (const envelope of envelopes) console.log(envelope);
    for (const line of summaries) console.error(line);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaries.join('\n') + '\n');
    return valid ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof UsageError ? 2 : 1;
  }
}
if (require.main === module) void main(process.argv.slice(2)).then(code => { process.exitCode = code; });
