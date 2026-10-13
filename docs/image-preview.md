# 图片预览

打开 png、jpg、jpeg、gif、webp、svg、bmp（以及 ico、avif）时走图片查看器，不走文本预览。

- 文件树里点一张图，会新开标签，标签里用 `<img>` 显示该文件的字节。
- 字节来自 `read_preview_image`：解析项目内或绝对路径，核对扩展名和文件头，最大 20MB。SVG 要求正文里有 `<svg`，用 `data:image/svg+xml` 显示，不把 SVG 当 HTML 执行。
- 文本查看器如果读到 `kind: image`，会改开图片查看器，不再显示「这个文件不能以文本预览。」
- 扩展名不是图片、或内容和扩展名不一致时，仍报错，不造一张图。
