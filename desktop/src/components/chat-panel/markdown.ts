import { marked } from "marked";
import DOMPurify from "dompurify";

const renderer = new marked.Renderer();
// Raw HTML and images are never interpreted, including while a stream is incomplete.
renderer.html = () => "";
renderer.image = ({ text }) => text.replace(/[&<>\"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export function renderMarkdown(target: HTMLElement, source: string) {
  const html = marked.parse(source, { renderer, gfm: true, breaks: true, async: false });
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em", "del", "a", "blockquote", "table", "thead", "tbody", "tr", "th", "td", "pre", "code", "hr"],
    ALLOWED_ATTR: ["href", "title", "start"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  for (const link of fragment.querySelectorAll("a")) {
    const href = link.getAttribute("href") || "";
    if (!/^https?:\/\//i.test(href)) link.removeAttribute("href");
    else { link.target = "_blank"; link.rel = "noopener noreferrer"; }
  }
  for (const table of fragment.querySelectorAll("table")) {
    const wrapper = document.createElement("div");
    wrapper.className = "cp-table-scroll";
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
  target.replaceChildren(fragment);
}
