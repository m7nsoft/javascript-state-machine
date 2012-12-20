//-----------------------------------------------------------------------------

module("graph");

//-----------------------------------------------------------------------------

test("create() can export state machine's graph as DOT source", function() {
  var fsmGraph = {};
  var fsm = StateMachine.create({
    initial: 'green',
    graph: fsmGraph,
    events: [
      { name: 'warn',  from: 'green',  to: 'yellow' },
      { name: 'panic', from: 'yellow', to: 'red'    },
      { name: 'calm',  from: 'red',    to: 'yellow' },
      { name: 'clear', from: 'yellow', to: 'green'  }
  ]});

  var expected = 'digraph fsm {\n' +
                 '  rankdir=LR;\n' +
                 '  node [shape = circle];\n' +
                 '  none -> green [ label = "startup" ];\n' +
                 '  green -> yellow [ label = "warn" ];\n' +
                 '  yellow -> red [ label = "panic" ];\n' +
                 '  red -> yellow [ label = "calm" ];\n' +
                 '  yellow -> green [ label = "clear" ];\n' +
                 '}\n';

  equals(fsmGraph.DOTSource, expected, "exported DOT source matches the expected value");
});

//-----------------------------------------------------------------------------

test("state machine's graph generation expands wildcards", function() {
  var fsmGraph = {};
  var fsm = StateMachine.create({
    initial: 'stopped',
    graph: fsmGraph,
    events: [
      { name: 'prepare', from: 'stopped',      to: 'ready'   },
      { name: 'start',   from: 'ready',        to: 'running' },
      { name: 'resume',  from: 'paused',       to: 'running' },
      { name: 'pause',   from: 'running',      to: 'paused'  },
      { name: 'stop',    /* any from state */  to: 'stopped' }
  ]});

  var expected = 'digraph fsm {\n' +
                 '  rankdir=LR;\n' +
                 '  node [shape = circle];\n' +
                 '  none -> stopped [ label = "startup" ];\n' +
                 '  stopped -> ready [ label = "prepare" ];\n' +
                 '  ready -> running [ label = "start" ];\n' +
                 '  paused -> running [ label = "resume" ];\n' +
                 '  running -> paused [ label = "pause" ];\n' +
                 '  none -> stopped [ label = "stop" ];\n' +
                 '  stopped -> stopped [ label = "stop" ];\n' +
                 '  ready -> stopped [ label = "stop" ];\n' +
                 '  running -> stopped [ label = "stop" ];\n' +
                 '  paused -> stopped [ label = "stop" ];\n' +
                 '}\n';

  equals(fsmGraph.DOTSource, expected, "exported DOT source matches the expected value");
});
