import { DcimCableTerminationTypeSchema } from '@repo/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormCombobox } from '@repo/ui/form/form-combobox';
import { FormSelect } from '@repo/ui/form/form-select';
import { useEffect } from 'react';
import type { Control, FieldValues, Path } from 'react-hook-form';
import { useWatch } from 'react-hook-form';
import { DeviceCombobox } from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';
import { enumOptions } from '~/lib/enum-options';

function PortCombobox<T extends FieldValues>({
  control,
  name,
  deviceId,
  terminationType,
}: {
  control: Control<T>;
  name: Path<T>;
  deviceId?: string;
  terminationType?: string;
}) {
  const on = (t: string) => terminationType === t && !!deviceId;
  const q = (type: string) => ({
    queryKey: ['cable-port', type, deviceId],
    queryData: { query: { deviceId, pageSize: 100 } },
    enabled: on(type),
  });

  const iface = tsr.listDcimInterfaces.useQuery(q('INTERFACE'));
  const consolePort = tsr.listDcimConsolePorts.useQuery(q('CONSOLE_PORT'));
  const consoleServerPort = tsr.listDcimConsoleServerPorts.useQuery(q('CONSOLE_SERVER_PORT'));
  const powerPort = tsr.listDcimPowerPorts.useQuery(q('POWER_PORT'));
  const powerOutlet = tsr.listDcimPowerOutlets.useQuery(q('POWER_OUTLET'));
  const frontPort = tsr.listDcimFrontPorts.useQuery(q('FRONT_PORT'));
  const rearPort = tsr.listDcimRearPorts.useQuery(q('REAR_PORT'));

  const optionMap: Record<string, { value: string; label: string }[]> = {
    INTERFACE: iface.data?.status === 200 ? iface.data.body.data.map((p) => ({ value: p.id, label: p.name })) : [],
    CONSOLE_PORT:
      consolePort.data?.status === 200 ? consolePort.data.body.data.map((p) => ({ value: p.id, label: p.name })) : [],
    CONSOLE_SERVER_PORT:
      consoleServerPort.data?.status === 200
        ? consoleServerPort.data.body.data.map((p) => ({ value: p.id, label: p.name }))
        : [],
    POWER_PORT:
      powerPort.data?.status === 200 ? powerPort.data.body.data.map((p) => ({ value: p.id, label: p.name })) : [],
    POWER_OUTLET:
      powerOutlet.data?.status === 200 ? powerOutlet.data.body.data.map((p) => ({ value: p.id, label: p.name })) : [],
    FRONT_PORT:
      frontPort.data?.status === 200 ? frontPort.data.body.data.map((p) => ({ value: p.id, label: p.name })) : [],
    REAR_PORT:
      rearPort.data?.status === 200 ? rearPort.data.body.data.map((p) => ({ value: p.id, label: p.name })) : [],
  };
  const options = terminationType ? (optionMap[terminationType] ?? []) : [];

  const ready = !!deviceId && !!terminationType;
  return (
    <FormCombobox
      control={control}
      name={name}
      label="Port"
      options={options}
      disabled={!ready}
      placeholder={ready ? 'Select a port' : 'Select a device and port type first'}
      emptyMessage="No matching ports on this device"
    />
  );
}

export function CableTerminationPicker<T extends FieldValues>({
  control,
  resetPort,
  deviceName,
  typeName,
  portName,
  title,
}: {
  control: Control<T>;
  resetPort: () => void;
  deviceName: Path<T>;
  typeName: Path<T>;
  portName: Path<T>;
  title: string;
}) {
  const deviceId = useWatch({ control, name: deviceName });
  const terminationType = useWatch({ control, name: typeName });

  useEffect(() => {
    resetPort();
  }, [deviceId, terminationType, resetPort]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <DeviceCombobox control={control} name={deviceName} label="Device" />
        <FormSelect
          control={control}
          name={typeName}
          label="Port type"
          options={enumOptions(DcimCableTerminationTypeSchema)}
          placeholder="Select a port type"
        />
        <PortCombobox control={control} name={portName} deviceId={deviceId} terminationType={terminationType} />
      </CardContent>
    </Card>
  );
}
