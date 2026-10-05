import { releases as generated } from 'virtual:vystral-changelog';
import type { ChangelogRelease } from './changelog';

/** The newest CHANGELOG.md sections, parsed at build time (see vite.config.ts). */
export const RELEASES = generated as ChangelogRelease[];
