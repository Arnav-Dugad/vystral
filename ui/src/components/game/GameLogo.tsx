import { useLogoTone } from '../../lib/logoTone';

/** A store logo image that switches to its light version when the artwork is mostly black lettering. */
export function GameLogo({ src, alt, className }: { src: string; alt: string; className: string }) {
  const tone = useLogoTone(src);
  return <img className={className} src={src} alt={alt} data-logo-tone={tone ?? undefined} />;
}
