// 'marina@gmail.com' -> 'm***@g***.com'. Só para diagnóstico excepcional (RNF-PRIV-01).
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.indexOf('.');
  const tail = dot > 0 ? domain.slice(dot) : '';
  return `${[...local][0]}***@${[...domain][0]}***${tail}`;
}

// Remove caracteres de controle (C0, DEL, C1, inclui CR/LF/TAB) e separadores de linha Unicode.
export function stripControl(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '');
}
