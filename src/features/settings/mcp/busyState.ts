/** 一行或表单一次操作一张票据。后完成的旧请求不能清掉新请求的忙碌。 */

export interface McpBusyBook {
  rows: Record<string, number>;
  form: number | null;
}

export function emptyBusy(): McpBusyBook {
  return { rows: {}, form: null };
}

export function busyNames(book: McpBusyBook): string[] {
  return Object.keys(book.rows);
}

export function formBusy(book: McpBusyBook): boolean {
  return book.form !== null;
}

export function beginRow(book: McpBusyBook, name: string, ticket: number): McpBusyBook {
  return { ...book, rows: { ...book.rows, [name]: ticket } };
}

export function endRow(book: McpBusyBook, name: string, ticket: number): McpBusyBook {
  if (book.rows[name] !== ticket) return book;
  const rows = { ...book.rows };
  delete rows[name];
  return { ...book, rows };
}

export function beginForm(book: McpBusyBook, ticket: number): McpBusyBook {
  return { ...book, form: ticket };
}

export function endForm(book: McpBusyBook, ticket: number): McpBusyBook {
  if (book.form !== ticket) return book;
  return { ...book, form: null };
}
