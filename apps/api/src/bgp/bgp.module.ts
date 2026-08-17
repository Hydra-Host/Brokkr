import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma';
import { AsnController } from './asn/asn.controller';
import { AsnService } from './asn/asn.service';
import { BgpPeerGroupController } from './bgp-peer-group/bgp-peer-group.controller';
import { BgpPeerGroupService } from './bgp-peer-group/bgp-peer-group.service';
import { BgpSessionController } from './bgp-session/bgp-session.controller';
import { BgpSessionService } from './bgp-session/bgp-session.service';
import { PrefixListRuleController } from './prefix-list-rule/prefix-list-rule.controller';
import { PrefixListRuleService } from './prefix-list-rule/prefix-list-rule.service';
import { PrefixListController } from './prefix-list/prefix-list.controller';
import { PrefixListService } from './prefix-list/prefix-list.service';

@Module({
  imports: [PrismaModule],
  controllers: [
    AsnController,
    BgpPeerGroupController,
    PrefixListController,
    PrefixListRuleController,
    BgpSessionController,
  ],
  providers: [AsnService, BgpPeerGroupService, PrefixListService, PrefixListRuleService, BgpSessionService],
  exports: [AsnService, BgpPeerGroupService, PrefixListService, PrefixListRuleService, BgpSessionService],
})
export class BgpModule {}
