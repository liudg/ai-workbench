import { useState } from "react";

import { ChatThumb } from "../answer/ChatThumb";
import { ImageLightbox } from "../answer/ImageLightbox";
import { fileName } from "../composer/media";

export function EventImages({
  paths,
  className,
  frameClassName,
}: {
  paths: string[];
  className: string;
  /** 不传则直接铺开缩略图，批注气泡不额外包一层。 */
  frameClassName?: string;
}) {
  const [opened, setOpened] = useState<number | null>(null);
  if (paths.length === 0) return null;
  const images = paths.map((path) => ({ path, name: fileName(path) }));
  const thumbs = images.map((image, index) => (
    <button
      key={image.path}
      type="button"
      data-chat-image-open
      aria-label={`预览图片：${image.name}`}
      className="min-w-0 max-w-full cursor-zoom-in rounded-xl p-0 outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
      onClick={() => setOpened(index)}
    >
      <ChatThumb path={image.path} name={image.name} className={className} />
    </button>
  ));
  const lightbox =
    opened != null ? <ImageLightbox images={images} start={opened} onClose={() => setOpened(null)} /> : null;
  if (!frameClassName) {
    return (
      <>
        {thumbs}
        {lightbox}
      </>
    );
  }
  return (
    <div className={frameClassName}>
      {thumbs}
      {lightbox}
    </div>
  );
}
