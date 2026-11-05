import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { GRAPH, ServiceGraph } from '../../composition';
import { DomainError } from '../../domain/errors';
import { Principal, Role } from './principal';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export type AuthedRequest = Request & { principal: Principal };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(GRAPH) private readonly graph: ServiceGraph,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!token) throw new UnauthorizedException();
    try {
      request.principal = await this.graph.verifier.verify(token);
      return true;
    } catch (err) {
      if (err instanceof DomainError && err.status === 401) throw new UnauthorizedException();
      throw new UnauthorizedException();
    }
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (!request.principal || !roles.includes(request.principal.role)) {
      throw new DomainError('role is not allowed on this route', 'forbidden', 403);
    }
    return true;
  }
}
