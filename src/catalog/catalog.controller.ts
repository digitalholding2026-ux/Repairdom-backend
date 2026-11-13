import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard.js';
import type { RequestUser } from '../auth/auth.types.js';
import { CatalogV2Service } from './catalog.service.js';

/**
 * M1 — catalogue public des prestations Relio v2. Aucune authentification
 * requise ; le guard optionnel lit la session quand elle existe, uniquement
 * pour choisir le tarif applicable (B2B ou public). Le visiteur ne peut pas
 * demander un tarif : il n'a pas de prise sur ce choix.
 */
@Controller('services')
@UseGuards(OptionalJwtAuthGuard)
export class CatalogController {
  constructor(private readonly catalog: CatalogV2Service) {}

  @Get()
  listServices(@Req() request: Request) {
    return this.catalog.listServices(clientTypeOf(request));
  }

  @Get(':code/categories')
  listCategories(@Param('code') code: string, @Req() request: Request) {
    return this.catalog.listCategories(code, clientTypeOf(request));
  }

  @Get(':code/categories/:catId/items')
  listItems(
    @Param('code') code: string,
    @Param('catId') catId: string,
    @Req() request: Request,
    @Query('targetDevice') targetDevice?: string,
  ) {
    return this.catalog.listItems(code, catId, clientTypeOf(request), targetDevice);
  }
}

/** La nature du visiteur, telle que la session l'a déclarée — jamais une question de paramètre. */
function clientTypeOf(request: Request): string | undefined {
  return (request as Request & { user?: RequestUser }).user?.clientType;
}
