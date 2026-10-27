import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Role } from '../enums/role.enum';
import { resolveJwtContract } from '../jwt.config';
import type { AuthenticatedUser, JwtPayload } from '../types/auth.types';

// Variante stateless (ADR-0021): valida localmente e devolve os claims, sem Prisma nem AuthService.
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    const contract = resolveJwtContract(config);
    const { algorithm } = contract;
    const verificationKey =
      algorithm === 'RS256'
        ? config.get<string>('JWT_PUBLIC_KEY')
        : config.get<string>('JWT_SECRET');
    if (!verificationKey) {
      throw new Error('JWT verification key environment variable is required');
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: verificationKey,
      algorithms: [algorithm],
      issuer: contract.issuer,
      audience: contract.audience,
      maxAge: `${contract.expiresIn}s`,
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    if (!payload.sub?.trim() || !payload.iss || !payload.aud || typeof payload.exp !== 'number') {
      throw new UnauthorizedException();
    }
    // Token sem role e cliente (edge-topology.md, secao 3): nunca ganha papel de staff.
    const role = payload.role ?? Role.CLIENTE;
    if (!Object.values(Role).includes(role)) {
      throw new UnauthorizedException();
    }
    return { id: payload.sub, email: payload.email, role };
  }
}
