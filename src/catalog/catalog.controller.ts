import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
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
  listServices() {
    return this.catalog.listServices();
  }

  @Get(':code/categories')
  listCategories(@Param('code') code: string) {
    return this.catalog.listCategories(code);
  }

  @Get(':code/categories/:catId/items')
  listItems(@Param('code') code: string, @Param('catId') catId: string, @Req() request: Request) {
    const user = (request as Request & { user?: RequestUser }).user;
    return this.catalog.listItems(code, catId, { forPro: user?.clientType === 'B2B' });
  }
}
