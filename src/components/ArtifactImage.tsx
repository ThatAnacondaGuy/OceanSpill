import { useEffect, useState } from 'react';
import { fileUrl } from '../data/world';

/**
 * A picture that comes from the case artifacts, such as a SAR quicklook. Against a server the file
 * is fetched with the session token and shown from an object URL; on the static site it is just the
 * file path, so the markup is the same either way.
 */
export function ArtifactImage({ path, alt, className }: { path: string; alt: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    setFailed(false);
    setSrc(null);
    fileUrl(path)
      .then((url) => {
        if (cancelled) {
          if (url.startsWith('blob:')) URL.revokeObjectURL(url);
          return;
        }
        if (url.startsWith('blob:')) revoke = url;
        setSrc(url);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [path]);

  if (failed) {
    return (
      <div className={`${className ?? ''} flex items-center justify-center bg-gray-50 border border-dashed border-gray-300 px-3 py-6 text-center text-[0.75rem] text-gray-600`}>
        This image could not be loaded.
      </div>
    );
  }
  if (!src) return <div className={`${className ?? ''} bg-gray-100 animate-pulse min-h-24`} aria-busy="true" aria-label={`Loading ${alt}`} />;
  return <img src={src} alt={alt} className={className} onError={() => setFailed(true)} />;
}
