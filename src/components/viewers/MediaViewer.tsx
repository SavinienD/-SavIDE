// axe:viewers — native audio/video player. The asset protocol answers HTTP
// range requests, so media are streamed from disk, never loaded whole.

import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Icon } from "@iconify/react";
import { formatBytes } from "./bytes";
import { OpenWithDefaultApp } from "./common";

export default function MediaViewer({
  path,
  name,
  size,
  video,
}: {
  path: string;
  name: string;
  size: number;
  video: boolean;
}) {
  const [error, setError] = useState(false);
  const src = convertFileSrc(path);

  if (error) {
    return (
      <div className="xv-state">
        <Icon icon="solar:videocamera-record-linear" width={18} height={18} />
        <span>Ce format n&rsquo;est pas lisible par le lecteur intégré.</span>
        <OpenWithDefaultApp path={path} />
      </div>
    );
  }
  return (
    <div className="xv-media" data-video={video ? "true" : "false"}>
      {video ? (
        <video className="xv-media__video" src={src} controls preload="metadata" onError={() => setError(true)} />
      ) : (
        <div className="xv-media__audio">
          <span className="xv-media__icon">
            <Icon icon="solar:music-note-2-linear" width={28} height={28} />
          </span>
          <span className="xv-media__name">{name}</span>
          <audio src={src} controls preload="metadata" onError={() => setError(true)} />
        </div>
      )}
      <div className="xv-media__meta">
        <span>{name}</span>
        <span>{formatBytes(size)}</span>
      </div>
    </div>
  );
}
