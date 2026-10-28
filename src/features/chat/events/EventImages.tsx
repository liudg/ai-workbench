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
      className="min-w-0 max-w-full cursor-zoom-in p-0"
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
