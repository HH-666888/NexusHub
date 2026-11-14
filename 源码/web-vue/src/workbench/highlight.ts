const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

function escapeHtml(text: string) {
  return String(text).replace(/[&<>]/g, (char) => ESCAPES[char]);
}

/** 与工作台原引擎一致的极简高亮：注释 / 字符串 / HTML / 关键字 / 数字。 */
export function highlight(text: string) {
  const re =
    /(#[^\n]*|--[^\n]*|\/\/[^\n]*)|('[^']*'|"[^"]*")|(<\/?[a-zA-Z][^>]*>)|(\b(?:import|from|def|return|with|as|class|function|const|let|if|else|for|while|async|await|new|true|false|null|CREATE|TABLE|IF|NOT|EXISTS|PRIMARY|KEY|INDEX|ON|NULL|DEFAULT)\b)|(\b\d+\.?\d*\b)/g;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, match.index));
    if (match[1]) out += `<span class="c">${escapeHtml(match[1])}</span>`;
    else if (match[2]) out += `<span class="s">${escapeHtml(match[2])}</span>`;
    else if (match[3]) out += `<span class="t">${escapeHtml(match[3])}</span>`;
    else if (match[4]) out += `<span class="k">${escapeHtml(match[4])}</span>`;
    else out += `<span class="n">${escapeHtml(match[5] || "")}</span>`;
    last = match.index + match[0].length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}