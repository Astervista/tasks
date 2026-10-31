/** Request validation; the shapes come from the shared contract in @tasks/core */
import {
  CreateTodoRequest,
  CreateWorkspaceRequest,
  CheckInRequest,
  DeleteMode,
  PushFilesRequest,
  TodoCommand,
  TodoId,
  UpdateTodoRequest,
  UpdateWorkspaceRequest,
} from '@tasks/core';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateWorkspaceDto implements CreateWorkspaceRequest {
  @IsString() @IsNotEmpty() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(20_000) description?: string;
  @IsString() @IsNotEmpty() timezone!: string;
}

export class UpdateWorkspaceDto implements UpdateWorkspaceRequest {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(20_000) description?: string;
  @IsOptional() @IsString() @IsNotEmpty() timezone?: string;
  @IsOptional() @IsNumber() @Min(0) archiveAfterDays?: number;
}

export class CreateTodoDto implements CreateTodoRequest {
  @IsString() @IsNotEmpty() @MaxLength(500) name!: string;
  @IsNumber() @Min(0) weight!: number;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsNumber() @IsPositive() estimate?: number | null;
  @IsOptional() @IsString() @MaxLength(100_000) desc?: string;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsInt() parentId?: TodoId | null;
  @IsOptional() @IsInt() @Min(0) index?: number;
}

export class UpdateTodoDto implements UpdateTodoRequest {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(500) name?: string;
  @IsOptional() @IsNumber() @Min(0) weight?: number;
  @IsOptional() @IsString() @MaxLength(100_000) desc?: string;
  @IsOptional() @IsIn(['running', 'paused', 'done']) status?: TodoCommand;
  @IsOptional() @IsNumber() at?: number;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsNumber() @IsPositive() estimate?: number | null;
  @IsOptional() @IsBoolean() withDescendants?: boolean;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsInt() parentId?: TodoId | null;
  @IsOptional() @IsInt() @Min(0) index?: number;
}

export class CheckInDto implements CheckInRequest {
  @IsNumber() @Min(0) @Max(1) progress!: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class DeleteTodoQueryDto {
  @IsOptional() @IsIn(['subtree', 'promote']) mode?: DeleteMode;
}

export class StatsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) days?: number;
  @IsOptional() @Type(() => Number) @IsInt() parent?: number;
}

export class PushFilesDto implements PushFilesRequest {
  @IsString() @MaxLength(5_000_000) todo!: string;
  @IsNumber() modified!: number;
}
