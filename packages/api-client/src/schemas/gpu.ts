import { z } from 'zod';

export const GpuQuantitySchema = z.enum(['1-10', '11-100', '100+']).describe('Quantity range of GPUs requested');
export type GpuQuantity = z.infer<typeof GpuQuantitySchema>;

export const GPU_TYPE_VALUES = [
  '3070',
  '3080',
  '3090',
  '4090',
  '5090',
  'a10',
  'a100',
  'a40',
  'a4000',
  'a4500',
  'a5000',
  'a6000',
  'b200',
  'b300',
  'cpu',
  'gb200',
  'gb300',
  'gh200',
  'h100',
  'h200',
  'l40',
  'l40s',
  'mi100',
  'mi200',
  'mi250',
  'mi300',
  'mi300x',
  'p100',
  'rtx6000',
  't4',
  'v100',
  'virtual machine',
] as const;

export const GpuTypeSchema = z.enum(GPU_TYPE_VALUES).describe('GPU hardware model or compute type');
export type GpuType = z.infer<typeof GpuTypeSchema>;
