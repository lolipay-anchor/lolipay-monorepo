declare module 'passport-jwt' {
  import { Strategy as PassportStrategy } from 'passport';

  export interface StrategyOptions {
    secretOrKey?: string | Buffer;
    jwtFromRequest: JwtFromRequestFunction;
    issuer?: string;
    audience?: string;
    algorithms?: string[];
    ignoreExpiration?: boolean;
    passReqToCallback?: false;
  }

  export type JwtFromRequestFunction = (req: any) => string | null;

  export const ExtractJwt: {
    fromAuthHeaderAsBearerToken(): JwtFromRequestFunction;
    fromHeader(header_name: string): JwtFromRequestFunction;
    fromBodyField(field_name: string): JwtFromRequestFunction;
    fromUrlQueryParameter(param_name: string): JwtFromRequestFunction;
    fromAuthHeaderWithScheme(auth_scheme: string): JwtFromRequestFunction;
    fromExtractors(extractors: JwtFromRequestFunction[]): JwtFromRequestFunction;
  };

  export class Strategy extends PassportStrategy {
    constructor(options: StrategyOptions, verify: (payload: any, done: (err: any, user?: any) => void) => void);
  }
}
