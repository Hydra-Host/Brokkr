import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma';
import { CircuitTerminationController } from './circuit-termination/circuit-termination.controller';
import { CircuitTerminationService } from './circuit-termination/circuit-termination.service';
import { CircuitTypeController } from './circuit-type/circuit-type.controller';
import { CircuitTypeService } from './circuit-type/circuit-type.service';
import { CircuitController } from './circuit/circuit.controller';
import { CircuitService } from './circuit/circuit.service';
import { ProviderNetworkController } from './provider-network/provider-network.controller';
import { ProviderNetworkService } from './provider-network/provider-network.service';
import { ProviderController } from './provider/provider.controller';
import { ProviderService } from './provider/provider.service';

@Module({
  imports: [PrismaModule],
  controllers: [
    ProviderController,
    ProviderNetworkController,
    CircuitTypeController,
    CircuitController,
    CircuitTerminationController,
  ],
  providers: [ProviderService, ProviderNetworkService, CircuitTypeService, CircuitService, CircuitTerminationService],
  exports: [ProviderService, ProviderNetworkService, CircuitTypeService, CircuitService, CircuitTerminationService],
})
export class CircuitsModule {}
