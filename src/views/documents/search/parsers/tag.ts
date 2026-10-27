import { SearchToken, TagToken } from "../tokens";

export class TagTokenParser {
  prefix = "tag:";

  serialize = (token: TagToken) => {
    return (token.excluded ? "-" : "") + this.prefix + token.value;
  };

  parse = (text: string): TagToken | undefined => {
    if (!text) return;

    // Tags are matched as written, without the # (spec/search.md).
    text = text.replace(/"/g, "");
    if (text.startsWith("#")) text = text.slice(1);
    if (!text) return;

    return { type: "tag", value: text };
  };

  add = (tokens: SearchToken[], token: TagToken) => {
    // there can be only one of each named journal
    if (
      tokens.find(
        (t) =>
          t.type === "tag" &&
          t.value === token.value &&
          (t as TagToken).excluded === token.excluded,
      )
    ) {
      return tokens;
    }

    // returning a copy is consistent with other methods,
    // but feels useless
    const copy = tokens.slice();
    copy.push(token);
    return copy;
  };

  remove = (tokens: SearchToken[], token: TagToken) => {
    // Find the token matching this one... and remove it...
    return tokens.filter((t) => {
      // Keep all non-journal tokens
      if (t.type !== "tag") return true;

      // Remove if it matches...
      return (
        t.value !== token.value || (t as TagToken).excluded !== token.excluded
      );
    });
  };
}
