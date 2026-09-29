import assert from 'node:assert/strict'
import test from 'node:test'
import { classroomTools } from '../src/voice/tools/classroom-tools.mjs'
import { ClientActionPort } from '../src/client/client-action-port.mjs'
import { TaskManager } from '../src/task/task-manager.mjs'

test('Demo and note creation use background tasks and only complete after saving', async () => {
  for (const kind of ['demo', 'note']) {
    const manager = new TaskManager()
    let release
    const generated = new Promise(resolve => { release = resolve })
    const requests = []
    const source = classroomTools({ supports: () => true, request: async (_name, args) => {
      requests.push(args)
      return { output: args.name === 'classroom.generation_context' ? { page: 2, guide: '当前课件依据' } : { id: 'saved-file' } }
    } }, { taskManager: manager, getContext: () => ({ ownerId: 'owner', sessionId: 'class', turnId: 'turn' }), backendRuntime: { run: async (input, options) => {
      assert.match(input.instruction, /当前课件依据/)
      assert.ok(input.objective)
      assert.ok(options.taskId)
      await generated
      return { content: JSON.stringify({ body: kind === 'demo' ? '<h1>Demo</h1>' : '# 笔记' }) }
    } } })
    const definition = source.tools().find(tool => tool.name === `classroom.create_${kind}`)
    assert.equal(definition.policy.mode, 'background')
    assert.ok(!definition.definition.function.parameters.properties.body)
    const accepted = await source.execute(`classroom.create_${kind}`, { title: '新文件', objective: '依据当前课堂创建' })
    assert.equal(accepted.status, 'accepted')
    assert.equal(requests.length, 1)
    release()
    await manager.wait(accepted.task_id)
    const task = manager.getByTaskId(accepted.task_id, { ownerId: 'owner' })
    assert.equal(task.status, 'completed')
    assert.match(task.result, /saved-file/)
    assert.equal(requests[1].name, 'classroom.save_generated_asset')
    assert.equal(requests[1].kind, kind)
    assert.equal(requests[1].requestId, accepted.task_id)
  }
})

test('classroom tool waits for correlated client result and cannot delete', async () => {
  let request
  const port = new ClientActionPort({ send: value => { request = value }, getCapabilities: () => ['client.actions.classroom.tool'] })
  const tools = classroomTools(port)
  assert.ok(tools.tools().some(tool => tool.name === 'classroom.inspect_slide'))
  assert.ok(!tools.tools().some(tool => /delete/.test(tool.name)))
  let completed = false
  const promise = tools.execute('classroom.inspect_slide', { materialId: 'deck', page: 2, question: 'Explain arrows' }).then(value => { completed = true; return value })
  await Promise.resolve()
  assert.equal(completed, false)
  assert.equal(request.arguments.question, 'Explain arrows')
  port.receive({ type: 'client.action.result', event_id: 'client-1', request_event_id: request.event_id, status: 'completed', output: { answer: 'data flow' } })
  assert.deepEqual(await promise, { answer: 'data flow' })
  await assert.rejects(tools.execute('classroom.delete_demo', {}), /Unsupported/)
  const failed = tools.execute('classroom.inspect_slide', { page: 3 })
  port.receive({ type: 'client.action.result', event_id: 'client-2', request_event_id: request.event_id, status: 'failed', error: { code: 'VISION_FAILED', message: 'unavailable' } })
  await assert.rejects(failed, /unavailable/)
  port.close()
  assert.deepEqual(classroomTools({ supports: () => false }).tools(), [])
})

test('background file creation reports failure when the classroom cannot save', async () => {
  const manager = new TaskManager()
  const source = classroomTools({ supports: () => true, request: async (_name, args) => {
    if (args.name === 'classroom.save_generated_asset') throw new Error('Client disconnected')
    return { output: { page: 1 } }
  } }, { taskManager: manager, getContext: () => ({ ownerId: 'owner', sessionId: 'class', turnId: 'turn' }), backendRuntime: {
    run: async () => ({ content: '{"body":"# 笔记"}' }),
  } })
  const accepted = await source.execute('classroom.create_note', { title: '笔记', objective: '记录概念' })
  await manager.wait(accepted.task_id)
  const task = manager.getByTaskId(accepted.task_id, { ownerId: 'owner' })
  assert.equal(task.status, 'failed')
  assert.match(task.error, /Client disconnected/)
})
