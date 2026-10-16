/** 后打开的浮层在栈顶。Esc 只关掉这一层。 */

type Close = () => void;

const stack: Close[] = [];

export function pushDismissLayer(close: Close): () => void {
  stack.push(close);
  return () => {
    const index = stack.lastIndexOf(close);
    if (index >= 0) stack.splice(index, 1);
  };
}

export function dismissTop(): boolean {
  const close = stack[stack.length - 1];
  if (!close) return false;
  close();
  return true;
}

export function dismissLayerCount(): number {
  return stack.length;
}

export function isDismissTop(close: Close): boolean {
  return stack[stack.length - 1] === close;
}
