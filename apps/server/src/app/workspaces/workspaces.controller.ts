import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { User } from '../identity/identity.middleware';
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
  list(@User() user: string) {
    return this.service.list(user);
  }

  @Post()
  create(@User() user: string, @Body() body: CreateWorkspaceDto) {
    return this.service.create(user, body);
  }

  @Get(':uid')
  get(@User() user: string, @Param('uid') uid: string) {
    return this.service.get(user, uid);
  }

  @Patch(':uid')
  update(@User() user: string, @Param('uid') uid: string, @Body() body: UpdateWorkspaceDto) {
    return this.service.update(user, uid, body);
  }

  @Delete(':uid')
  @HttpCode(204)
  remove(@User() user: string, @Param('uid') uid: string) {
    return this.service.remove(user, uid);
  }

  @Get(':uid/stats')
  stats(@User() user: string, @Param('uid') uid: string, @Query() query: StatsQueryDto) {
    return this.service.stats(user, uid, Math.min(query.days ?? 14, 366), query.parent ?? null);
  }

  // Todos -------------------------------------------------------------------------------------

  @Post(':uid/todos')
  addTodo(@User() user: string, @Param('uid') uid: string, @Body() body: CreateTodoDto) {
    return this.service.addTodo(user, uid, body);
  }

  @Patch(':uid/todos/:id')
  updateTodo(@User() user: string, @Param('uid') uid: string, @Param('id', ParseIntPipe) id: number, @Body() body: UpdateTodoDto) {
    return this.service.updateTodo(user, uid, id, body);
  }

  @Delete(':uid/todos/:id')
  deleteTodo(@User() user: string, @Param('uid') uid: string, @Param('id', ParseIntPipe) id: number, @Query() query: DeleteTodoQueryDto) {
    return this.service.deleteTodo(user, uid, id, query.mode ?? 'subtree');
  }

  /** "How far along?": refines the ETA */
  @Post(':uid/todos/:id/checkins')
  checkIn(@User() user: string, @Param('uid') uid: string, @Param('id', ParseIntPipe) id: number, @Body() body: CheckInDto) {
    return this.service.checkIn(user, uid, id, body.progress, body.note ?? '');
  }

  /** Discards the running session */
  @Delete(':uid/todos/:id/timer')
  resetTimer(@User() user: string, @Param('uid') uid: string, @Param('id', ParseIntPipe) id: number) {
    return this.service.resetTimer(user, uid, id);
  }

  /** Moves a todo that isn't running (with its subtree) to the archive */
  @Post(':uid/todos/:id/archive')
  archive(@User() user: string, @Param('uid') uid: string, @Param('id', ParseIntPipe) id: number) {
    return this.service.archive(user, uid, id);
  }

  /** Brings an archived todo (with its whole archived subtree) back */
  @Post(':uid/archive/:id/restore')
  restore(@User() user: string, @Param('uid') uid: string, @Param('id', ParseIntPipe) id: number) {
    return this.service.restore(user, uid, id);
  }

  // Files (sync) ------------------------------------------------------------------------------

  @Get(':uid/files')
  files(@User() user: string, @Param('uid') uid: string) {
    return this.service.files(user, uid);
  }

  @Put(':uid/files')
  pushFiles(@User() user: string, @Param('uid') uid: string, @Body() body: PushFilesDto) {
    return this.service.pushFiles(user, uid, body);
  }
}
