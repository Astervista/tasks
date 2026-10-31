import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service';
import {
  CheckInDto,
  CreateTodoDto,
  CreateWorkspaceDto,
  DeleteTodoQueryDto,
  PushFilesDto,
  StatsQueryDto,
  UpdateTodoDto,
  UpdateWorkspaceDto,
} from './dto';

@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly service: WorkspacesService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Post()
  create(@Body() body: CreateWorkspaceDto) {
    return this.service.create(body);
  }

  @Get(':uid')
  get(@Param('uid') uid: string) {
    return this.service.get(uid);
  }

  @Patch(':uid')
  update(@Param('uid') uid: string, @Body() body: UpdateWorkspaceDto) {
    return this.service.update(uid, body);
  }

  @Delete(':uid')
  @HttpCode(204)
  remove(@Param('uid') uid: string) {
    return this.service.remove(uid);
  }

  @Get(':uid/stats')
  stats(@Param('uid') uid: string, @Query() query: StatsQueryDto) {
    return this.service.stats(uid, Math.min(query.days ?? 14, 366), query.parent ?? null);
  }

  // Todos -------------------------------------------------------------------------------------

  @Post(':uid/todos')
  addTodo(@Param('uid') uid: string, @Body() body: CreateTodoDto) {
    return this.service.addTodo(uid, body);
  }

  @Patch(':uid/todos/:id')
  updateTodo(@Param('uid') uid: string, @Param('id', ParseIntPipe) id: number, @Body() body: UpdateTodoDto) {
    return this.service.updateTodo(uid, id, body);
  }

  @Delete(':uid/todos/:id')
  deleteTodo(@Param('uid') uid: string, @Param('id', ParseIntPipe) id: number, @Query() query: DeleteTodoQueryDto) {
    return this.service.deleteTodo(uid, id, query.mode ?? 'subtree');
  }

  /** "How far along?": refines the ETA */
  @Post(':uid/todos/:id/checkins')
  checkIn(@Param('uid') uid: string, @Param('id', ParseIntPipe) id: number, @Body() body: CheckInDto) {
    return this.service.checkIn(uid, id, body.progress, body.note ?? '');
  }

  /** Discards the running session */
  @Delete(':uid/todos/:id/timer')
  resetTimer(@Param('uid') uid: string, @Param('id', ParseIntPipe) id: number) {
    return this.service.resetTimer(uid, id);
  }

  /** Brings an archived todo (with its whole archived subtree) back */
  @Post(':uid/archive/:id/restore')
  restore(@Param('uid') uid: string, @Param('id', ParseIntPipe) id: number) {
    return this.service.restore(uid, id);
  }

  // Files (sync) ------------------------------------------------------------------------------

  @Get(':uid/files')
  files(@Param('uid') uid: string) {
    return this.service.files(uid);
  }

  @Put(':uid/files')
  pushFiles(@Param('uid') uid: string, @Body() body: PushFilesDto) {
    return this.service.pushFiles(uid, body);
  }
}
