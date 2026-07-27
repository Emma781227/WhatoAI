import { PartialType } from '@nestjs/swagger';

import { CreateOrganizationDto } from './create-organization.dto';

/** Tous les champs de création, optionnels. Le statut n'est PAS modifiable ici (route archive dédiée). */
export class UpdateOrganizationDto extends PartialType(CreateOrganizationDto) {}
