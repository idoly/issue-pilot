import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface AliyunCliCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
}

async function secureFile(file: string): Promise<void> {
  const metadata = await stat(file);
  if (!metadata.isFile() || (metadata.mode & 0o022) !== 0) throw new Error("insecure_aliyun_cli_file");
}

export async function withAliyunCliProfile<Result>(
  cliPath: string,
  credentials: AliyunCliCredentials,
  operation: (profileRoot: string) => Promise<Result>,
): Promise<Result> {
  await secureFile(cliPath);
  const profileRoot = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-aliyun-"));
  try {
    const aliyunRoot = path.join(profileRoot, ".aliyun");
    await mkdir(aliyunRoot, { mode: 0o700 });
    await writeFile(path.join(aliyunRoot, "config.json"), JSON.stringify({
      current: "issue-pilot",
      profiles: [{
        name: "issue-pilot",
        mode: "AK",
        region_id: credentials.region,
        output_format: "json",
        language: "en",
        site: "China",
        access_key_id: credentials.accessKeyId,
        access_key_secret: credentials.accessKeySecret,
      }],
    }), { mode: 0o600 });
    return await operation(profileRoot);
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
}
