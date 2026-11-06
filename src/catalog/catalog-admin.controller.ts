import { Body, Controller, Delete, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CatalogAdminService } from './catalog-admin.service.js';
import {
  CreateCatalogItemDto,
  UpdateCatalogItemDto,
  UpdateCatalogItemPricesDto,
} from './dto/catalog-item.dto.js';

/** M1 — tenue du catalogue v2 par l'administration (les clients lisent, ils n'écrivent pas). */
@Controller('admin/catalog')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class CatalogAdminController {
  constructor(private readonly catalog: CatalogAdminService) {}

  @Post('items')
  createItem(@Body() dto: CreateCatalogItemDto) {
    return this.catalog.createItem(dto);
  }

  @Patch('items/:id')
  updateItem(@Param('id') id: string, @Body() dto: UpdateCatalogItemDto) {
    return this.catalog.updateItem(id, dto);
  }

  @Delete('items/:id')
  deactivateItem(@Param('id') id: string) {
    return this.catalog.deactivateItem(id);
  }

  @Patch('items/:id/prices')
  updatePrices(@Param('id') id: string, @Body() dto: UpdateCatalogItemPricesDto) {
    return this.catalog.updatePrices(id, dto);
  }
}
