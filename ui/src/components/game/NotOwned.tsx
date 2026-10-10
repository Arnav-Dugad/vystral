import { PackageX } from 'lucide-react';
import type { Installation } from '../../bridge/types';
import { formatDate, formatRelative } from '../../lib/format';
import './not-owned.css';

/** Track C1: what the Library's "No longer owned" filter shows, and why. */
export function NotOwnedNote({ count }: { count: number }) {
  return (
    <p className="not-owned-note" role="note">
      <PackageX size={16} aria-hidden />
      <span>
        {count === 0
          ? 'Nothing here. Games show up here when Steam stops listing them on your account.'
          : `Steam no longer lists ${count === 1 ? 'this game' : 'these games'} on your account (refunded or removed), so ${count === 1 ? 'it’s' : 'they’re'} kept out of the rest of VYSTRAL. Play history, notes and ratings stay, and everything comes back if you buy ${count === 1 ? 'it' : 'them'} again.`}
      </span>
    </p>
  );
}

/**
 * Track C1: the package facts a version card can add — version, install date, and a last-played date that is
 * only an estimate from save data, labelled as such. Renders definition-list rows (or nothing).
 */
export function PackageFacts({ inst }: { inst: Installation }) {
  return (
    <>
      {inst.version && <div><dt className="caps">Version</dt><dd className="num selectable">{inst.version}</dd></div>}
      {inst.installedAt && <div><dt className="caps">Installed</dt><dd>{formatDate(inst.installedAt)}</dd></div>}
      {inst.lastPlayedSource === 'saveData' && inst.importedLastPlayed && (
        <div>
          <dt className="caps">Last played</dt>
          <dd title={formatDate(inst.importedLastPlayed, { dateStyle: 'medium', timeStyle: 'short' })}>
            {formatRelative(inst.importedLastPlayed)} <span className="not-owned-est">(estimated from save data)</span>
          </dd>
        </div>
      )}
      {inst.noLongerOwned && <div><dt className="caps">Left your Steam library</dt><dd>{formatDate(inst.noLongerOwned)}</dd></div>}
    </>
  );
}
