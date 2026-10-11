import { ChatThumb } from "../answer/ChatThumb";
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
  if (paths.length === 0) return null;
  const thumbs = paths.map((path) => (
    <ChatThumb key={path} path={path} name={fileName(path)} className={className} />
  ));
  if (!frameClassName) return <>{thumbs}</>;
  return <div className={frameClassName}>{thumbs}</div>;
}
