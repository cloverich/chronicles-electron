import { isDateToken } from "../../../../contract/rules";
import { AfterToken, BeforeToken, SearchToken } from "../tokens";

type BoundToken = BeforeToken | AfterToken;

/**
 * before:<date> and after:<date> filter on createdAt. At most one of each;
 * adding another replaces it. Values that aren't YYYY[-MM[-DD]] are dropped.
 */
class DateBoundTokenParser<T extends BoundToken> {
  prefix: string;
  constructor(private type: T["type"]) {
    this.prefix = `${type}:`;
  }

  serialize = (token: T) => {
    return this.prefix + token.value;
  };

  parse = (text: string): T | undefined => {
    if (!text || !isDateToken(text)) return;
    return { type: this.type, value: text } as T;
  };

  add = (tokens: SearchToken[], token: T) => {
    return [...this.remove(tokens, token), token];
  };

  remove = (tokens: SearchToken[], _token: T): SearchToken[] => {
    return tokens.filter((t) => t.type !== this.type);
  };
}

export class BeforeTokenParser extends DateBoundTokenParser<BeforeToken> {
  constructor() {
    super("before");
  }
}

export class AfterTokenParser extends DateBoundTokenParser<AfterToken> {
  constructor() {
    super("after");
  }
}
