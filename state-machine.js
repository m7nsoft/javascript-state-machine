//hey, hey, hey! I made some mods to this, but I don't like them. Instead of a new states array, what a proper (imo) impl should have is:
// - change events cfg prop to 'transitions', and field 'name' to 'event' (backwards compatibility would be ok)
// - allow regex definiton on event and from fields (maybe event_re and from_re to avoid problems) to ease default behaviors definition avoiding explicit listing of all valid and
//   usually similar event-state combinations.
//   · to impl this, we probably need a first pass on trasitions array to grab all event and state names, thus avoiding problems while processing regex that match
//     events or states defined in future entries.
//   · regex should have less priority than explicit definitions to impl default behaviours (i.e. go to some state when an event not explicitly defined for this source state occurs)

(function (window) {

  var StateMachine = {

    //---------------------------------------------------------------------------

    VERSION: "2.2.0",

    //---------------------------------------------------------------------------

    Result: {
      SUCCEEDED:    1, // the event transitioned successfully from one state to another
      NOTRANSITION: 2, // the event was successfull but no state transition was necessary
      CANCELLED:    3, // the event was cancelled by the caller in a beforeEvent callback
      ASYNC:        4 // the event is asynchronous and the caller is in control of when the transition occurs
    },

    Error: {
      INVALID_TRANSITION: 100, // caller tried to fire an event that was innapropriate in the current state
      PENDING_TRANSITION: 200, // caller tried to fire an event while an async transition was still pending
      INVALID_CALLBACK:   300 // caller provided callback function threw an exception
    },

    WILDCARD: '*',
    ASYNC: 'async',

    //---------------------------------------------------------------------------

    create: function(cfg, target) {

      var initial;
      var fsm       = target || cfg.target  || {};
      var raw_definitions = cfg.transitions || cfg.events || []; // { event: 'str' | event_regex: 'str', from from_regex, to}
      var callbacks = cfg.callbacks || {};
      var map       = {}; // stores the active destination state for a given event-from pair
      var defMap    = {};  // same structure than map, but instead of storing the destination state, stores an array with the attributes of all the transition definitions that define a destination for a given event-from pair
      var graph     = cfg.graph; // if cfg.graph is defined, create() adds to it a string member named 'DOTSource' containing the state machine's graph in DOT language

      var events = []; // collected event names for regex expansion
      var states = []; // collected state names for regex expansion
      var definitions; // preprocessed transition definitions array (regex strings and wildcard values replaced by RegExp instances, single strings wrapped in an array, etc.)

      /* ============= create's helper functions ========== */

      // processes xxx/xxx_regex field pairs an returns either an array or a RegExp instance
      var processFields = function(value, regex) {
        if (value && regex)
          return {error: "Specify explicit values or a regex, not both"};

        var wildcard_regex = new RegExp('.*');
        var ret;

        if (!value && !regex) {
          ret = wildcard_regex; // backwards compat for missing 'from'. Note that this will also be applied for missing 'event' and 'event_regex'.
        } else if (value) {
          var val = (value instanceof Array) ? value : [value];
          var has_wildcard = val.some(function(elem) { return elem === StateMachine.WILDCARD; });
          if (has_wildcard) {
            if (val.length === 1) {
              ret = wildcard_regex;
            } else {
              //XXX mixed values and wildcards... I would throw an error here. However, backwards compatibility wins
              ret = wildcard_regex;
            }
          } else {
            ret = val;
          }
        } else if (regex) {
          ret = new RegExp(regex);
        } else {
          throw "ASSERT: We shouldn't reach this point!!!";
        }

        return ret;
      };

      var collectNames = function(def) { // definitions should already be preprocessed and checked
        if (!(def.event instanceof RegExp)) {
          events = events.concat(def.event);
        }
        if (!(def.from instanceof RegExp)) {
          states = states.concat(def.from);
        }
        if (def.to) {
          states.push(def.to);
        }
      };

      var getActiveDef = function(defList) {
        var actives = defList.filter(function(def) { return def.active; });
        if (actives.length !== 1) {
          throw "ASSERT: More than one active definition?!!";
        }
        return actives[0];
      };

      // Given two definitions of the same transition, decides which has higher priority.
      // Currently, the only rule is that a regex has less priority than a explicit value.
      var getHigherPriorityDef = function(a, b) {
        var e1 = {error: "All regex"};  //TODO meaningful messages, please
        var e2 = {error: "Mixed stuff"};
        var e3 = {error: "All explicit"};

        // Defines the output for all the combinations of {a, b}.{is_event_regex, is_from_regex} 
        // 0 = regex, 1 = EXPLICIT
        // a.e a.f b.e b.f (msb to lsb)
        var table = [
          e1, b,  b,  b,
          a,  e2, e2, b,
          a,  e2, e2, b,
          a,  a,  a,  e3
        ];

        if ( typeof a.is_event_regex !== 'boolean'
          || typeof a.is_from_regex  !== 'boolean'
          || typeof b.is_event_regex !== 'boolean'
          || typeof b.is_from_regex  !== 'boolean')
        {
          throw "ASSERT: Something is wrong in regex flags";
        }

        // note that table is defined with value 0 for regex
        var idx = !a.is_event_regex << 3 | !a.is_from_regex << 2 | !b.is_event_regex << 1 | !b.is_from_regex;

        return table[idx];
      };

      var addDefinition = function(def) {

        // expand event regex if necessary
        var eventList;
        var is_event_regex = false;
        if (def.event instanceof RegExp) {
          is_event_regex = true;
          eventList = events.filter(function(e) { return def.event.test(e); });
        } else {
          eventList = def.event;
        }

        // expand from regex if necessary
        var froms;
        var is_from_regex = false;
        if (def.from instanceof RegExp) {
          is_from_regex = true;
          froms = states.filter(function(s) { return def.from.test(s); });
        } else {
          froms = def.from;
        }

        // add the transition for each event and from (checking conflicts, etc.)
        eventList.forEach(function(e) {
          map[e] = map[e] || {};
          defMap[e] = defMap[e] || {};

          froms.forEach(function(from) {
            var currentDef = {};
            currentDef.to = def.to;
            currentDef.idx = def.idx;
            currentDef.is_event_regex = is_event_regex;
            currentDef.is_from_regex  = is_from_regex;
            currentDef.active = false;

            if (map[e][from]) {
              var activeDef = getActiveDef(defMap[e][from]);

              if (map[e][from] !== def.to) { // conflict: different targets for the same transition
                var winner = getHigherPriorityDef(activeDef, def);
                if (winner.error) {
                  throw "Conflicting transition definitions (" + activeDef.idx + " and " + def.idx + ") for event '" + e + "' and from '" + from + "': " + winner.error;
                }

                if (winner === def) {
                  map[e][from] = def.to;
                  activeDef.active = false;
                  def.active = true;
                }
              }

              defMap[e][from].push(def);
            } else { // first transition definition for these event and from
              def.active = true;
              map[e][from] = def.to || from;
              defMap[e][from] = [def];
            }
          });
        });
      };

      // XXX if we want/need to generate fancier graphs may be worth it to look for a graphviz generation lib
      //     or to write our own helper methods, i.e. printEdge(to, from, {label: xxx, color: ...})
      var exportGraphviz = function(params) {
        var graph = '';
        var params = params || {};

        var wline = function(str){
          graph += str + '\n';
        };
        var color = function(e, f) {
          var c;
          if (e && f) {
            c = 'purple';
          } else if (e && !f) {
            c = 'red';
          } else if (!e && f) {
            c = 'blue';
          } else if (!e && !f) {
            c = 'black';
          }
          return c;
        };

        wline('digraph fsm {');
        wline('  rankdir=LR;');
        wline('  node [shape = circle];');

        for (var event in map) {
          if (map.hasOwnProperty(event)) {
            var eventMap = map[event];
            for (var from in eventMap) {
              if (eventMap.hasOwnProperty(from)) {
                var defs = defMap[event][from];
                var def = getActiveDef(defs);

                var defsListStr = '';
                if (params.defsList) {
                    var indexes = defs.map(function(def) { return def.idx; });
                    var idxStr = indexes.length > 1 ? '[' + indexes + ']' : '';
                    defsListStr = ' (t:' + def.idx + idxStr + ')';
                }
                
                var colorStr = ''; 
                if (params.colors) {
                    colorStr = ', color = ' + color(def.is_event_regex, def.is_from_regex);
                }

                wline('  ' + from + ' -> ' + eventMap[from] + ' [ label = "' + event + defsListStr + '"' + colorStr + ' ];');
              }
            }
          }
        }

        wline('}');
        return graph;
      };

      /* ================ create starts here ============= */

      if (cfg.initial) {
        // allow for a simple string, or an object with { state: 'foo', event: 'setup', defer: true|false }
        initial = (typeof cfg.initial == 'string') ? { state: cfg.initial } : cfg.initial;

        // match initial format with definitions' entry format
        initial.event = (initial.event instanceof Array) ? initial.event : (initial.event ? [initial.event] : ['startup']);
        initial.from  = ['none'];
        initial.to    = initial.state;

        addDefinition(initial);

        // TODO should we add initial 'event' and 'to' to the lists for regex expansion???
      }

      // preprocess transition definitions
      definitions = raw_definitions.map(function(t, idx) {
        var new_t = {};

        new_t.to = t.to;
        new_t.idx = idx;

        var from = processFields(t.from, t.from_regex);
        if (from.error) {
          throw "Error in from/from_regex of [" + idx + "]: " + from.error;
        }
        new_t.from = from;

        var event = processFields(t.event || t.name, t.event_regex);
        if (event.error) {
          throw "Error in event/event_regex of [" + idx + "]: " + event.error;
        }
        new_t.event = event;

        return new_t;
      });

      // collect 'named' events and states
      definitions.forEach(function(def){ collectNames(def); });

      // remove duplicates from collected lists
      events = events.filter(function(elem, pos, array) { return array.indexOf(elem) === pos; });
      states = states.filter(function(elem, pos, array) { return array.indexOf(elem) === pos; });

      // create the map. Regexs are expanded here
      definitions.forEach(function(def) { addDefinition(def); });


      for(var name in map) {
        if (map.hasOwnProperty(name))
          fsm[name] = StateMachine.buildEvent(name, map[name]);
      }

      for(var name in callbacks) {
        if (callbacks.hasOwnProperty(name))
          fsm[name] = callbacks[name];
      }

      fsm.current = 'none';
      fsm.is      = function(state) { return this.current == state; };
      fsm.can     = function(event) { return !this.transition && (map[event].hasOwnProperty(this.current)); };
      fsm.cannot  = function(event) { return !this.can(event); };
      fsm.error   = cfg.error || function(name, from, to, args, error, msg, e) { throw e || msg; }; // default behavior when something unexpected happens is to throw an exception, but caller can override this behavior if desired (see github issue #3 and #17)

      if (graph) {
        graph.DOTSource = exportGraphviz();
      }

      if (initial && !initial.defer)
        fsm[initial.event]();

      return fsm;

    },

    //===========================================================================

    doCallback: function(fsm, func, name, from, to, args) {
      if (func) {
        try {
          return func.apply(fsm, [name, from, to].concat(args));
        }
        catch(e) {
          return fsm.error(name, from, to, args, StateMachine.Error.INVALID_CALLBACK, "an exception occurred in a caller-provided callback function", e);
        }
      }
    },

    beforeEvent: function(fsm, name, from, to, args) { return StateMachine.doCallback(fsm, fsm['onbefore' + name],                     name, from, to, args); },
    afterEvent:  function(fsm, name, from, to, args) { return StateMachine.doCallback(fsm, fsm['onafter'  + name] || fsm['on' + name], name, from, to, args); },
    leaveState:  function(fsm, name, from, to, args) { return StateMachine.doCallback(fsm, fsm['onleave'  + from],                     name, from, to, args); },
    enterState:  function(fsm, name, from, to, args) { return StateMachine.doCallback(fsm, fsm['onenter'  + to]   || fsm['on' + to],   name, from, to, args); },
    changeState: function(fsm, name, from, to, args) { return StateMachine.doCallback(fsm, fsm['onchangestate'],                       name, from, to, args); },


    buildEvent: function(name, map) {
      return function() {

        var from  = this.current;
        var to    = map[from];
        var args  = Array.prototype.slice.call(arguments); // turn arguments into pure array

        if (this.transition)
          return this.error(name, from, to, args, StateMachine.Error.PENDING_TRANSITION, "event " + name + " inappropriate because previous transition did not complete");

        if (this.cannot(name))
          return this.error(name, from, to, args, StateMachine.Error.INVALID_TRANSITION, "event " + name + " inappropriate in current state " + this.current);

        if (false === StateMachine.beforeEvent(this, name, from, to, args))
          return StateMachine.CANCELLED;

        if (from === to) {
          StateMachine.afterEvent(this, name, from, to, args);
          return StateMachine.NOTRANSITION;
        }

        // prepare a transition method for use EITHER lower down, or by caller if they want an async transition (indicated by an ASYNC return value from leaveState)
        var fsm = this;
        this.transition = function() {
          fsm.transition = null; // this method should only ever be called once
          fsm.current = to;
          StateMachine.enterState( fsm, name, from, to, args);
          StateMachine.changeState(fsm, name, from, to, args);
          StateMachine.afterEvent( fsm, name, from, to, args);
        };
        this.transition.cancel = function() { // provide a way for caller to cancel async transition if desired (issue #22)
          fsm.transition = null;
          StateMachine.afterEvent(fsm, name, from, to, args);
        }

        var leave = StateMachine.leaveState(this, name, from, to, args);
        if (false === leave) {
          this.transition = null;
          return StateMachine.CANCELLED;
        }
        else if ("async" === leave) {
          return StateMachine.ASYNC;
        }
        else {
          if (this.transition)
            this.transition(); // in case user manually called transition() but forgot to return ASYNC
          return StateMachine.SUCCEEDED;
        }

      };
    }

  }; // StateMachine

  //===========================================================================

  if ("function" === typeof define) {
    define(function(require) { return StateMachine; });
  }
  else {
    window.StateMachine = StateMachine;
  }

}(this));

