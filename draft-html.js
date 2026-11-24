(function exposeDraftHtml(global) {
  const formattingTags = new Set([
    "a", "abbr", "address", "article", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite",
    "code", "col", "colgroup", "dd", "del", "div", "dl", "dt", "em", "figcaption", "figure", "font",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p",
    "pre", "q", "s", "samp", "section", "small", "span", "strike", "strong", "sub", "sup", "table",
    "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "var", "wbr"
  ]);
  const discardedTags = new Set(["script", "style", "iframe", "object", "embed", "template", "svg", "math", "noscript"]);
  const formattingAttributes = new Set([
    "align", "alt", "border", "cellpadding", "cellspacing", "color", "colspan", "data-checked",
    "data-language", "data-list", "data-row", "data-casepaste-content-version", "data-content-version-id",
    "data-content-document-id", "data-file-id", "dir", "face", "height", "lang", "reversed", "rowspan",
    "scope", "size", "span", "spellcheck", "start", "title", "type", "valign", "value", "width"
  ]);
  const formattingStyles = new Set([
    "background-color", "border", "border-bottom", "border-collapse", "border-color", "border-left",
    "border-radius", "border-right", "border-spacing", "border-style", "border-top", "border-width",
    "color", "direction", "font", "font-family", "font-size", "font-style", "font-variant", "font-weight",
    "height", "letter-spacing", "line-height", "list-style-type", "max-width", "width", "word-spacing",
    "margin", "margin-block", "margin-block-end", "margin-block-start", "margin-bottom", "margin-inline",
    "margin-inline-end", "margin-inline-start", "margin-left", "margin-right", "margin-top",
    "padding", "padding-block", "padding-block-end", "padding-block-start", "padding-bottom", "padding-inline",
    "padding-inline-end", "padding-inline-start", "padding-left", "padding-right", "padding-top",
    "tab-size", "text-align", "text-decoration", "text-decoration-color", "text-decoration-line",
    "text-decoration-style", "text-decoration-thickness", "text-indent", "text-transform", "vertical-align", "white-space"
  ]);

  function createFragment(html, document, { preview = false, baseUrl = document.baseURI } = {}) {
    // Parse in an inert template. Only formatting and safe media URLs can enter either DOM.
    const template = document.createElement("template");
    template.innerHTML = typeof html === "string" ? preserveLeadingCodeLine(html) : "";

    for (const node of template.content.querySelectorAll("*")) {
      if (!template.content.contains(node)) {
        continue;
      }

      const tag = node.localName;
      if (discardedTags.has(tag) || node.hasAttribute("data-casepaste-anchor") ||
        node.classList.contains("ql-cursor") || node.classList.contains("ql-ui")) {
        node.remove();
      } else if (!formattingTags.has(tag)) {
        node.replaceWith(...node.childNodes);
      } else {
        cleanAttributes(node, baseUrl, preview, document.baseURI);
      }
    }

    return template.content;
  }

  function preserveLeadingCodeLine(html) {
    // The browser strips the first LF after <pre> when parsing, but innerHTML does not add
    // it back when serializing an editor. Compensate for that one LF in native snapshots.
    const tagsAndComments = /<!--[\s\S]*?-->|<\/?[a-z][\w:-]*(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
    return html.replace(tagsAndComments, (tag, offset) => {
      return /^<pre(?:\s|>)/i.test(tag) && html[offset + tag.length] === "\n" ? `${tag}\n` : tag;
    });
  }

  function cleanAttributes(node, baseUrl, preview, currentBaseUrl) {
    for (const { name, value } of Array.from(node.attributes)) {
      if (name === "class") {
        if (preview) {
          const editorClasses = value.split(/\s+/).filter((entry) => /^ql-[\w-]+$/.test(entry));
          node.className = editorClasses.join(" ");
        }
      } else if (name === "style") {
        for (const property of Array.from(node.style)) {
          if (!formattingStyles.has(property)) {
            node.style.removeProperty(property);
          }
        }
      } else if (!isFormattingAttribute(node.localName, name, value, baseUrl, preview)) {
        node.removeAttribute(name);
      } else if ((preview || baseUrl !== currentBaseUrl) &&
        ["href", "src", "data-cke-saved-src", "data-cke-saved-href"].includes(name)) {
        node.setAttribute(name, new URL(value, baseUrl).href);
      }
    }
    if (preview && node.localName === "a" && node.hasAttribute("href")) {
      node.target = "_blank";
      node.rel = "noopener noreferrer";
    }
    if (preview && node.localName === "img") {
      node.referrerPolicy = "no-referrer";
      node.loading = "lazy";
    }
  }

  function isFormattingAttribute(tag, name, value, baseUrl, preview) {
    if ((name === "href" || name === "data-cke-saved-href") && tag === "a") {
      return (name === "href" || !preview) && hasProtocol(value, baseUrl, ["https:", "http:", "mailto:", "tel:"]);
    }
    if (name === "target" && tag === "a") {
      return !preview && ["_blank", "_self"].includes(value);
    }
    if (name === "rel" && tag === "a") {
      return !preview;
    }
    if (name === "src" && tag === "img") {
      return isEmbeddedImage(value) || (preview
        ? isSalesforceFileImage(value, baseUrl)
        : hasProtocol(value, baseUrl, ["https:", "http:"]));
    }
    if (name === "data-cke-saved-src" && tag === "img") {
      return !preview && (isEmbeddedImage(value) || hasProtocol(value, baseUrl, ["https:", "http:"]));
    }
    if (name === "contenteditable") {
      return !preview && value === "false";
    }
    return formattingAttributes.has(name);
  }

  function hasProtocol(value, baseUrl, allowed) {
    try {
      return Boolean(value.trim()) && allowed.includes(new URL(value, baseUrl).protocol);
    } catch {
      return false;
    }
  }

  function isEmbeddedImage(value) {
    return /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,/i.test(value);
  }

  function isSalesforceFileImage(value, baseUrl) {
    try {
      const url = new URL(value, baseUrl);
      return url.protocol === "https:" && !url.username && !url.password &&
        /(?:^|\.)(?:salesforce(?:-visualforce)?\.com|force\.com|visualforce\.com)$/i.test(url.hostname) &&
        /^\/(?:sfc\/servlet\.shepherd\/|servlet\/(?:rtaImage|servlet\.(?:FileDownload|ImageServer))(?:\/|$))/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  async function freezeBlobImages(html, document) {
    const template = document.createElement("template");
    template.innerHTML = preserveLeadingCodeLine(html);
    const view = document.defaultView;
    const reads = new Map();
    const images = Array.from(template.content.querySelectorAll('img[src^="blob:"]'));
    await Promise.all(images.map(async (image) => {
      const source = image.getAttribute("src");
      if (!reads.has(source)) {
        reads.set(source, readBlobImage(source, view));
      }
      const replacement = await reads.get(source);
      if (replacement) {
        image.src = replacement;
        if (image.getAttribute("data-cke-saved-src") === source) {
          image.setAttribute("data-cke-saved-src", replacement);
        }
      } else {
        image.removeAttribute("src");
      }
    }));
    return template.innerHTML;
  }

  async function readBlobImage(source, view) {
    try {
      const response = await view.fetch(source);
      if (!response.ok) return "";
      const blob = await response.blob();
      // Keep room for the rest of the draft in Chrome's 10 MB storage area.
      if (blob.size > 4 * 1024 * 1024) return "";
      const encoded = await new Promise((resolve) => {
        const reader = new view.FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve("");
        reader.readAsDataURL(blob);
      });
      return isEmbeddedImage(encoded) ? encoded : "";
    } catch {
      return "";
    }
  }

  global.SfdgDraftHtml = { createFragment, freezeBlobImages };
})(globalThis);
