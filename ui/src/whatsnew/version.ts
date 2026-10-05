/** SemVer ordering for VYSTRAL versions (major.minor.patch, a pre-release sorts before its release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split('+')[0].split(/-(.*)/s);
    const n = core.split('.').map((x) => Number.parseInt(x, 10) || 0);
    return { n: [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0], pre: pre || null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) if (pa.n[i] !== pb.n[i]) return pa.n[i] < pb.n[i] ? -1 : 1;
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** Feature releases since `since`: 0 within the same minor line, 1 for the next minor, and so on. */
export function featureReleasesBetween(since: string, current: string): number {
  const idx = (v: string) => {
    const [maj, min] = v.split('.').map((x) => Number.parseInt(x, 10) || 0);
    return maj * 1000 + min;
  };
  return idx(current) - idx(since);
}

export const isVersion = (v: unknown): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v);
