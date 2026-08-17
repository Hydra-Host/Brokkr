import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma';
import { CableController } from './cable/cable.controller';
import { CableService } from './cable/cable.service';
import { ConnectionController } from './connection/connection.controller';
import { ConnectionService } from './connection/connection.service';
import { ConsolePortController } from './console-port/console-port.controller';
import { ConsolePortService } from './console-port/console-port.service';
import { ConsoleServerPortController } from './console-server-port/console-server-port.controller';
import { ConsoleServerPortService } from './console-server-port/console-server-port.service';
import { FrontPortController } from './front-port/front-port.controller';
import { FrontPortService } from './front-port/front-port.service';
import { InterfaceController } from './interface/interface.controller';
import { InterfaceService } from './interface/interface.service';
import { PowerOutletController } from './power-outlet/power-outlet.controller';
import { PowerOutletService } from './power-outlet/power-outlet.service';
import { PowerPortController } from './power-port/power-port.controller';
import { PowerPortService } from './power-port/power-port.service';
import { RackRoleController } from './rack-role/rack-role.controller';
import { RackRoleService } from './rack-role/rack-role.service';
import { RackElevationService } from './rack/rack-elevation.service';
import { RackController } from './rack/rack.controller';
import { RackService } from './rack/rack.service';
import { RearPortController } from './rear-port/rear-port.controller';
import { RearPortService } from './rear-port/rear-port.service';

@Module({
  imports: [PrismaModule],
  controllers: [
    InterfaceController,
    RackController,
    RackRoleController,
    CableController,
    ConsolePortController,
    ConsoleServerPortController,
    FrontPortController,
    RearPortController,
    PowerPortController,
    PowerOutletController,
    ConnectionController,
  ],
  providers: [
    InterfaceService,
    RackService,
    RackElevationService,
    RackRoleService,
    CableService,
    ConsolePortService,
    ConsoleServerPortService,
    FrontPortService,
    RearPortService,
    PowerPortService,
    PowerOutletService,
    ConnectionService,
  ],
  exports: [
    InterfaceService,
    RackService,
    RackElevationService,
    RackRoleService,
    CableService,
    ConsolePortService,
    ConsoleServerPortService,
    FrontPortService,
    RearPortService,
    PowerPortService,
    PowerOutletService,
    ConnectionService,
  ],
})
export class DcimModule {}
