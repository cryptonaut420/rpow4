import { NavLink } from 'react-router-dom';
import { DEFAULT_ASSET_SLUG, useAsset } from '../assets/AssetProvider.js';
import { CopyButton } from './CopyButton.js';

/**
 * Top-of-app asset switcher. Renders:
 *   - An `instance` <select> populated from /assets, with RPOW4.0 always
 *     pinned at the top so users can return to the default asset from
 *     anywhere — even before /assets has loaded or if the URL points at a
 *     stale slug.
 *   - A `[ launch new rpow ]` link.
 *   - For custom assets: a description blurb and a "share this rpow" line
 *     with a copy-to-clipboard button on its own row, so the share affordance
 *     is highly visible (rather than buried next to the dropdown).
 */
export function AssetBar() {
  const { assets, selectedAsset, selectedSlug, selectAsset, assetPath, isDefaultAsset } = useAsset();
  const shareUrl = selectedAsset
    ? `${window.location.origin}${window.location.pathname}#/r/${selectedAsset.slug}`
    : '';

  // The /assets list normally includes RPOW4.0, but we defensively pin it
  // into the dropdown so it's always selectable — including during initial
  // load (before the response arrives) and for users who land on a slug
  // that no longer exists.
  const hasDefault = assets.some((a) => a.slug === DEFAULT_ASSET_SLUG);
  const dropdownOptions = hasDefault
    ? assets
    : [
        {
          id: '__default-fallback__',
          slug: DEFAULT_ASSET_SLUG,
          display_code: 'RPOW4.0',
          nickname: 'RPOW4',
          system_default: true,
        } as const,
        ...assets,
      ];
  // The currently-selected slug might not be in the dropdown yet (initial
  // load, deleted slug). Falling back to DEFAULT_ASSET_SLUG keeps the
  // dropdown's value matched to a visible <option>, which is what makes
  // the "switch back to RPOW4.0" interaction work as a single click.
  const selectValue = dropdownOptions.some((a) => a.slug === selectedSlug)
    ? selectedSlug
    : DEFAULT_ASSET_SLUG;

  const showBlurb = Boolean(
    selectedAsset && !selectedAsset.system_default && selectedAsset.description,
  );
  const showShare = !isDefaultAsset && Boolean(shareUrl);

  return (
    <div className="asset-bar" aria-label="rpow selector">
      <div className="asset-bar-row">
        <label>
          <span className="nav-group-label">instance</span>{' '}
          <select value={selectValue} onChange={(e) => selectAsset(e.target.value)}>
            {dropdownOptions.map((a) => (
              <option key={a.id} value={a.slug}>
                {a.display_code} · {a.nickname}{a.system_default ? ' (original)' : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="asset-bar-actions">
          <NavLink to={assetPath('/launch')}>[ launch new rpow ]</NavLink>
        </div>
      </div>
      {showBlurb ? (
        <div className="asset-bar-blurb" title={selectedAsset!.description}>
          {selectedAsset!.description}
        </div>
      ) : null}
      {showShare ? (
        <div className="asset-bar-share-row">
          <span className="asset-bar-share-label">share this rpow</span>
          <CopyButton text={shareUrl} label="copy link" title="copy shareable link to this rpow" />
        </div>
      ) : null}
    </div>
  );
}
