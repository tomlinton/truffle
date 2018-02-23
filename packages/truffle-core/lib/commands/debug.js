var command = {
  command: 'debug',
  description: 'Interactively debug any transaction on the blockchain (experimental)',
  builder: {
    _: {
      type: "string"
    }
  },
  run: function (options, done) {
    var OS = require("os");
    var path = require("path");
    var debugModule = require("debug");
    var debug = debugModule("lib:commands:debug");
    var safeEval = require('safe-eval')
    var util = require("util");
    var _ = require("lodash");

    var Config = require("truffle-config");
    var Debugger = require("truffle-debugger");
    var DebugUtils = require("truffle-debug-utils");
    var Environment = require("../environment");
    var ReplManager = require("../repl");
    var selectors = require("truffle-debugger").selectors;

    // Debugger Session properties
    var data = selectors.data;
    var context = selectors.context;
    var trace = selectors.trace;
    var solidity = selectors.solidity;
    var evm = selectors.evm;

    var config = Config.detect(options);

    Environment.detect(config, function(err) {
      if (err) return done(err);

      if (config._.length == 0) {
        return callback(new Error(
          "Please specify a transaction hash as the first parameter in order to " +
          "debug that transaction. i.e., truffle debug 0x1234..."
        ));
      }

      var txHash = config._[0];

      var lastCommand = "n";
      var enabledSelectors = new Set();
      var breakpoints = [];

      config.logger.log(DebugUtils.formatStartMessage());

      var sessionPromise = DebugUtils.gatherArtifacts(config)
        .then(function(contracts) {
          return Debugger.forTx(txHash, {
            provider: config.provider,
            contracts: contracts
          });
        })
        .then(function (bugger) {
          return bugger.connect();
        })
        .catch(done);

      sessionPromise.then(function (session) {
        if (err) return done(err);

        function splitLines(str) {
          // We were splitting on OS.EOL, but it turns out on Windows,
          // in some environments (perhaps?) line breaks are still denoted by just \n
          return str.split(/\r?\n/g);
        }

        function printAddressesAffected() {
          var affectedInstances = session.view(context.affectedInstances);

          config.logger.log("Addresses affected:");
          config.logger.log(DebugUtils.formatAffectedInstances(affectedInstances));
        }

        function printHelp() {
          config.logger.log("");
          config.logger.log(DebugUtils.formatHelp());
        }

        function printFile() {
          var message = "";

          debug("file: %o", session.view(context.current));
          var sourcePath = session.view(context.current).sourcePath;

          if (sourcePath) {
            message += path.basename(sourcePath);
          } else {
            message += "?";
          }

          var address = session.view(context.current).address;
          if (address) {
            message += " | " + address;
          }

          config.logger.log("");
          config.logger.log(message + ":");
        }

        function printState() {
          var source = session.view(context.current).source;
          var range = session.view(solidity.next.sourceRange);
          debug("source: %o", source);
          debug("range: %o", range);

          if (!source) {
            config.logger.log()
            config.logger.log("1: // No source code found.");
            config.logger.log("");
            return;
          }

          var lines = splitLines(source);

          config.logger.log("");

          config.logger.log(
            DebugUtils.formatRangeLines(lines, range.lines)
          );

          config.logger.log("");
        }

        function printInstruction() {
          var instruction = session.view(solidity.next.instruction);
          var step = session.view(trace.step);
          var traceIndex = session.view(trace.index);

          config.logger.log("");
          config.logger.log(
            DebugUtils.formatInstruction(traceIndex, instruction)
          );
          config.logger.log(DebugUtils.formatStack(step.stack));
        };

        function printSelector(specified) {
          var selector = specified
            .split(".")
            .filter(function(next) { return next.length > 0 })
            .reduce(function(sel, next) {
              debug("next %o, sel %o", next, sel);
              return sel[next];
            }, selectors);

          debug("selector %o", selector);
          var result = session.view(selector);
          var debugSelector = debugModule(specified);
          debugSelector.enabled = true;
          debugSelector("%O", result);
        };

        function printEnabledSelectors() {
          enabledSelectors.forEach(function(sel) {
            printSelector(sel);
          });
        };

        // TODO make this more robust for all cases and move to
        // truffle-debug-utils
        function formatValue(value, indent) {
          if (!indent) {
            indent = 0;
          }

          return util
            .inspect(value, {
              colors: true,
              depth: null,
              breakLength: 30
            })
            .split(/\r?\n/g)
            .map(function (line, i) {
              // don't indent first line
              var padding = i > 0 ?
                Array(indent).join(" ") :
                "";
              return padding + line;
            })
            .join(OS.EOL);
        }

        function printVariables() {
          var variables = session.view(data.identifiers.native.current);

          // Get the length of the longest name.
          var longestNameLength = Math.max.apply(null, (Object.keys(variables).map(function(name) {
            return name.length
          })));

          config.logger.log();

          Object.keys(variables).forEach(function(name) {
            var paddedName = name + ":";

            while (paddedName.length <= longestNameLength) {
              paddedName = " " + paddedName;
            }

            var value = variables[name];
            var formatted = formatValue(value, longestNameLength + 5);

            config.logger.log("  " + paddedName, formatted);
          });

          config.logger.log();
        }

        function evalAndPrintExpression(expr) {
          var context = session.view(data.identifiers.native.current);
          try {
            var result = safeEval(expr, context);
            var formatted = formatValue(result);
            config.logger.log(formatted);
            config.logger.log();
          } catch (e) {
            // HACK: safeEval edits the expression to capture the result, which
            // produces really weird output when there are errors. e.g.,
            //
            //   evalmachine.<anonymous>:1
            //   SAFE_EVAL_857712=a
            //   ^
            //
            //   ReferenceError: a is not defined
            //     at evalmachine.<anonymous>:1:1
            //     at ContextifyScript.Script.runInContext (vm.js:59:29)
            //
            // We want to hide this from the user if there's an error.
            e.stack = e.stack.replace(/SAFE_EVAL_\d+=/,"");
            config.logger.log(e)
          }
        }

        function toggleBreakpoint() {
          var currentCall = session.view(evm.current.call);
          var currentLine = session.view(solidity.next.sourceRange).lines.start.line;

          // Try to find the breakpoint in the list
          var found = false;
          for (var index = 0; index < breakpoints.length; index++) {
            var breakpoint = breakpoints[index];

            if (_.isEqual(currentCall, breakpoint.call) && currentLine == breakpoint.line) {
              found = true;
              // Remove the breakpoint
              breakpoints.splice(index, 1);
              break;
            }
          }

          if (found) {
            config.logger.log("Breakpoint removed.");
            return;
          }

          // No breakpoint? Add it.
          breakpoints.push({
            call: currentCall,
            line: currentLine
          });

          config.logger.log("Breakpoint added.");
        }

        function interpreter(cmd, replContext, filename, callback) {
          cmd = cmd.trim();
          var cmdArgs;
          debug("cmd %s", cmd);

          if (cmd == ".exit") {
            cmd = "q";
          }

          if (cmd.length > 0) {
            cmdArgs = cmd.slice(1).trim();
            cmd = cmd[0];
          }

          if (cmd == "") {
            cmd = lastCommand;
          }

          // Perform commands that require state changes.
          switch (cmd) {
            case "o":
              session.stepOver();
              break;
            case "i":
              session.stepInto();
              break;
            case "u":
              session.stepOut();
              break;
            case "n":
              session.stepNext();
              break;
            case ";":
              session.advance();
              break;
            case "c":
              session.continueUntil.apply(session, breakpoints);
              break;
            case "q":
              return repl.stop(callback);
          }

          // Check if execution has stopped.
          if (session.finished) {
            config.logger.log("");
            if (session.failed) {
              config.logger.log("Transaction halted with a RUNTIME ERROR.")
              config.logger.log("");
              config.logger.log("This is likely due to an intentional halting expression, like assert(), require() or revert(). It can also be due to out-of-gas exceptions. Please inspect your transaction parameters and contract code to determine the meaning of this error.");
            } else {
              config.logger.log("Transaction completed successfully.");
            }
            return repl.stop(callback);
          }

          // Perform post printing
          // (we want to see if execution stopped before printing state).
          switch (cmd) {
            case "!":
              enabledSelectors.add(cmdArgs);
            case "?":
              printSelector(cmdArgs);
              break;
            case "v":
              printVariables();
              break;
            case ":":
              evalAndPrintExpression(cmdArgs);
              break;
            case "b":
              toggleBreakpoint();
              break;
            case ";":
            case "p":
              printFile();
              printInstruction();
              printState();
              printEnabledSelectors();
              break;
            case "o":
            case "i":
            case "u":
            case "n":
            case "c":
              if(!session.view(context.current).source) {
                printInstruction();
              }

              printFile();
              printState();
              printEnabledSelectors();
              break;
            default:
              printHelp();
          }

          if (
            cmd != "i" && cmd != "u" && cmd != "b" && cmd != "v" &&
            cmd != "h" && cmd != "p" && cmd != "?" && cmd != "!" && cmd != ":"
          ) {
            lastCommand = cmd;
          }

          callback();
        };

        printAddressesAffected();
        printHelp();
        printFile();
        printState();

        var repl = options.repl || new ReplManager(config);

        repl.start({
          prompt: "debug(" + config.network + ":" + txHash.substring(0, 10) + "...)> ",
          interpreter: interpreter
        });

        // Call the done function even though the repl hasn't finished.
        // This leaves the process at the whim of the repl; the repl is
        // responsible for closing the process when done.
        done();
      });
    });
  }
}

module.exports = command;
