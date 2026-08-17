import { Injectable } from '@nestjs/common';
import { Asn, CreateAsnRequest, UpdateAsnRequest } from '@repo/api-client';
import { AsnRecord } from './asn.record';

@Injectable()
export class AsnService {
  async list(): Promise<Asn[]> {
    const records = await AsnRecord.list();
    return records.map((r) => r.data as Asn);
  }

  async findById(id: string): Promise<Asn> {
    const record = await AsnRecord.findByIdOrThrow(id);
    return record.data as Asn;
  }

  async create(input: CreateAsnRequest): Promise<Asn> {
    const record = await AsnRecord.create({ asn: input.asn, description: input.description });
    return record.data as Asn;
  }

  async update(id: string, input: UpdateAsnRequest): Promise<Asn> {
    const record = await AsnRecord.updateById(id, input);
    return record.data as Asn;
  }

  async delete(id: string) {
    await AsnRecord.deleteById(id);
  }
}
