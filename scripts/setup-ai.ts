import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, writeFile, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { unzipSync } from 'fflate';
import path from 'node:path';

if (process.platform !== 'win32')
  throw new Error(
    'This installer targets Windows. On other platforms run llama-server with Qwen3-VL and configure LOCAL_MODEL_URL.',
  );
const root = path.join(process.env.LOCALAPPDATA!, 'OnboardAI');
await mkdir(root, { recursive: true });
const revision = '52d6c8ffea26cc873ac5ad116f8631268d7eb503';
const files = [
  {
    name: 'llama-b12359-bin-win-vulkan-x64.zip',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12359/llama-b12359-bin-win-vulkan-x64.zip',
    sha: 'e8d18c6e4210cca87e7307c2ea78363ac8d158e4e1397358ec96ab70b53a0d5e',
  },
  {
    name: 'Qwen3VL-2B-Instruct-Q4_K_M.gguf',
    url: `https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/${revision}/Qwen3VL-2B-Instruct-Q4_K_M.gguf`,
    sha: '089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae',
  },
  {
    name: 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf',
    url: `https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/${revision}/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf`,
    sha: 'f9a68fabba69c3b81e153367b2c7521030b0fa8bb0de400c9599c8e6725f9c82',
  },
];
async function digest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
for (const file of files) {
  const target = path.join(root, file.name);
  if (
    await stat(target).then(
      () => true,
      () => false,
    )
  ) {
    if ((await digest(target)) === file.sha) {
      console.log(`Verified ${file.name}`);
      continue;
    }
    throw new Error(`Existing file has an unexpected checksum: ${target}`);
  }
  console.log(`Downloading ${file.name} into ${root}`);
  const response = await fetch(file.url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as any), createWriteStream(target + '.partial'));
  if ((await digest(target + '.partial')) !== file.sha)
    throw new Error(`Checksum mismatch for ${file.name}`);
  await rename(target + '.partial', target);
}
const runtime = path.join(root, 'llama-b12359');
if (
  !(await stat(path.join(runtime, 'llama-server.exe')).then(
    () => true,
    () => false,
  ))
) {
  const entries = unzipSync(await readFile(path.join(root, files[0].name)));
  for (const [name, bytes] of Object.entries(entries)) {
    const target = path.resolve(runtime, name);
    if (!target.startsWith(path.resolve(runtime) + path.sep))
      throw new Error('Invalid archive path');
    if (name.endsWith('/')) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}
await stat(path.join(runtime, 'llama-server.exe'));
await mkdir('.local', { recursive: true });
await writeFile(
  '.local/ai-runtime.json',
  JSON.stringify(
    {
      root,
      runtime,
      model: path.join(root, files[1].name),
      projector: path.join(root, files[2].name),
      revision,
    },
    null,
    2,
  ),
);
console.log('Local Qwen3-VL is installed and checksum verified. Run npm run ai:start.');
