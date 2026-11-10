import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class TrackSearchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  phone: string;
}

export interface TrackSearchResult {
  id: string;
  trackingToken: string | null;
  reference: string;
  service: string;
  status: string;
  createdAt: string;
  price: number | null;
}
