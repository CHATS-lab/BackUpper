/**
 * Host-agent tag: each installed hook command carries `--agent <name>`, which is exported as
 * BACKUPPER_HOST_AGENT so the tier-3 subagent can default to the same CLI and login.
 */

export function adoptHostAgent(argv: string[] = process.argv): void {
  const i = argv.indexOf("--agent");
  const name = i >= 0 ? argv[i + 1] : undefined;
  if (name && /^[a-z-]+$/.test(name)) process.env.BACKUPPER_HOST_AGENT = name;
}
