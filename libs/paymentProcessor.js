var fs = require('fs');
var request = require('request');

var redis = require('redis');
var async = require('async');

var Stratum = require('stratum-pool');
var util = require('stratum-pool/lib/util.js');

module.exports = function(logger){

    var poolConfigs = JSON.parse(process.env.pools);

    var enabledPools = [];

    Object.keys(poolConfigs).forEach(function(coin) {
        var poolOptions = poolConfigs[coin];
        if (poolOptions.paymentProcessing &&
            poolOptions.paymentProcessing.enabled)
            enabledPools.push(coin);
    });

    async.filter(enabledPools, function(coin, callback){
        SetupForPool(logger, poolConfigs[coin], function(setupResults){
            callback(null, setupResults);
        });
    }, function(err, results){
        results.forEach(function(coin){

            var poolOptions = poolConfigs[coin];
            var processingConfig = poolOptions.paymentProcessing;
            var logSystem = 'Payments';
            var logComponent = coin;

            logger.debug(logSystem, logComponent, 'Payment processing setup to run every '
                + processingConfig.paymentInterval + ' second(s) with daemon ('
                + processingConfig.daemon.user + '@' + processingConfig.daemon.host + ':' + processingConfig.daemon.port
                + ') and redis (' + poolOptions.redis.host + ':' + poolOptions.redis.port + ')');

        });
    });
};

function SetupForPool(logger, poolOptions, setupFinished){


    var coin = poolOptions.coin.name;
    var processingConfig = poolOptions.paymentProcessing;

    var logSystem = 'Payments';
    var logComponent = coin;
    var opidCount = 0;
    
    // zcash team recommends 10 confirmations for safety from orphaned blocks
    var minConfShield = Math.max((processingConfig.minConf || 10), 1);  //Dont allow 0 conf transactions.
    var minConfPayout = Math.max((processingConfig.minConf || 10), 1);
    
    if (minConfPayout  < 10) {
           logger.debug(logSystem, logComponent, logComponent + 'Minimum confirmations for payments is less than 10, this increases the chances of a payment being orphaned');
    }
    
    var maxBlocksPerPayment = processingConfig.maxBlocksPerPayment || 3;
    
    // pplnt - pay per last N time shares
    var pplntEnabled = processingConfig.paymentMode === "pplnt" || false;
    var pplntTimeQualify = processingConfig.pplnt || 0.51; // 51%
    
    var getMarketStats = poolOptions.coin.getMarketStats === true;
    var requireShielding = poolOptions.coin.requireShielding === true;
    var fee = parseFloat(poolOptions.coin.txfee) || parseFloat(0.0004);

    logger.debug(logSystem, logComponent, logComponent + ' requireShielding: ' + requireShielding);
    logger.debug(logSystem, logComponent, logComponent + ' minConf: ' + minConfShield);
    logger.debug(logSystem, logComponent, logComponent + ' payments txfee reserve: ' + fee);
    logger.debug(logSystem, logComponent, logComponent + ' maxBlocksPerPayment: ' + maxBlocksPerPayment);
    logger.debug(logSystem, logComponent, logComponent + ' PPLNT: ' + pplntEnabled + ', time period: '+pplntTimeQualify);

    var daemon = new Stratum.daemon.interface([processingConfig.daemon], function(severity, message){
        logger[severity](logSystem, logComponent, message);
    });
    var redisClient = redis.createClient(poolOptions.redis.port, poolOptions.redis.host);

    var magnitude;
    var minPaymentSatoshis;
    var coinPrecision;

    var paymentInterval;

    function validateAddress (callback){
        daemon.cmd('validateaddress', [poolOptions.address], function(result) {
            if (result.error){
                logger.error(logSystem, logComponent, 'Error with payment processing daemon ' + JSON.stringify(result.error));
                callback(true);
            }
            else if (!result.response || !result.response.ismine) {
                logger.error(logSystem, logComponent,
                    'Daemon does not own pool address - payment processing can not be done with this daemon, '
                    + JSON.stringify(result.response));
                callback(true);
            }
            else{
                callback()
            }
        }, true);
    }
    function validateTAddress (callback) {
        daemon.cmd('validateaddress', [poolOptions.tAddress], function(result) {
            if (result.error){
                logger.error(logSystem, logComponent, 'Error with payment processing daemon ' + JSON.stringify(result.error));
                callback(true);
            }
            else if (!result.response || !result.response.ismine) {
                logger.error(logSystem, logComponent,
                    'Daemon does not own pool address - payment processing can not be done with this daemon, '
                    + JSON.stringify(result.response));
                callback(true);
            }
            else{
                callback()
            }
        }, true);
     }
     function validateZAddress (callback) {
        daemon.cmd('z_validateaddress', [poolOptions.zAddress], function(result) {
            if (result.error){
                logger.error(logSystem, logComponent, 'Error with payment processing daemon ' + JSON.stringify(result.error));
                callback(true);
            }
            else if (!result.response || !result.response.ismine) {
                logger.error(logSystem, logComponent,
                    'Daemon does not own pool address - payment processing can not be done with this daemon, '
                    + JSON.stringify(result.response));
                callback(true);
            }
            else{
                callback()
            }
        }, true);
    }
    function getBalance(callback){
        daemon.cmd('getbalance', [], function(result){
            if (result.error){
                return callback(true);
            }
            try {
                var d = result.data.split('result":')[1].split(',')[0].split('.')[1];
                magnitude = parseInt('10' + new Array(d.length).join('0'));
                minPaymentSatoshis = parseInt(processingConfig.minimumPayment * magnitude);
                coinPrecision = magnitude.toString().length - 1;
            }
            catch(e){
                logger.error(logSystem, logComponent, 'Error detecting number of satoshis in a coin, cannot do payment processing. Tried parsing: ' + result.data);
                return callback(true);
            }
            callback();
        }, true, true);
    }

    function asyncComplete(err){
        if (err){
            setupFinished(false);
            return;
        }
        if (paymentInterval) {
            clearInterval(paymentInterval);
        }
        paymentInterval = setInterval(function(){
            try {
                processPayments();
            } catch(e){
                throw e;
            }
        }, processingConfig.paymentInterval * 1000);
        setTimeout(processPayments, 100);
        setupFinished(true);
    }

    if (requireShielding === true) {
        async.parallel([validateAddress, validateTAddress, validateZAddress, getBalance], asyncComplete);
    } else {
        async.parallel([validateAddress, validateTAddress, getBalance], asyncComplete);
    }
    
    //get t_address coinbalance
    function listUnspent (addr, notAddr, minConf, displayBool, callback) {
        if (addr !== null) {
            var args = [minConf, 99999999, [addr]];
        } else {
            addr = 'Payout wallet';
            var args = [minConf, 99999999];
        }
        daemon.cmd('listunspent', args, function (result) {
            //Check if payments failed because wallet doesn't have enough coins to pay for tx fees
            if (result.error) {
                logger.error(logSystem, logComponent, 'Error trying to get t-addr ['+addr+'] balance with RPC listunspent.'
                    + JSON.stringify(result.error));
                callback = function (){};
                callback(true);
            }
            else {
                var tBalance = 0;
                if (result[0].response != null && result[0].response.length > 0) {
                    for (var i = 0, len = result[0].response.length; i < len; i++) {
                        if (result[0].response[i].address !== notAddr) {
                            tBalance = tBalance + (result[0].response[i].amount * magnitude);
                        }
                    }
                }
                if (displayBool === true) {
                    logger.special(logSystem, logComponent, addr+' balance of ' + (tBalance / magnitude).toFixed(8));
                }
                callback(null, tBalance.toFixed(8));
            }
        });
    }

    // get z_address coinbalance
    function listUnspentZ (addr, minConf, displayBool, callback) {
        daemon.cmd('z_getbalance', [addr, minConf], function (result) {
            //Check if payments failed because wallet doesn't have enough coins to pay for tx fees
            if (result[0].error) {
                logger.error(logSystem, logComponent, 'Error trying to get coin balance with RPC z_getbalance.' + JSON.stringify(result[0].error));
                callback = function (){};
                callback(true);
            }
            else {
                var zBalance = 0;
                if (result[0].response != null) {
                    zBalance = result[0].response;
                }
                if (displayBool === true) {
                    logger.special(logSystem, logComponent, addr.substring(0,14) + '...' + addr.substring(addr.length - 14) + ' balance: '+(zBalance).toFixed(8));
                }
                callback(null, (zBalance * magnitude).toFixed(8));
            }
        });
    }

    //send t_address balance to z_address
    function sendTToZ (callback, tBalance) {
        if (callback === true)
            return;
        if ((tBalance - 10000) < 0)
            return;

        // do not allow more than a single z_sendmany operation at a time
        if (opidCount > 0) {
            logger.warning(logSystem, logComponent, 'sendTToZ is waiting, too many z_sendmany operations already in progress.');
            return;
        }

        var amount = satoshisToCoins(tBalance - 10000);
        var params = [poolOptions.address, [{'address': poolOptions.zAddress, 'amount': amount}]];
        daemon.cmd('z_sendmany', params,
            function (result) {
                //Check if payments failed because wallet doesn't have enough coins to pay for tx fees
                if (result.error) {
                    logger.error(logSystem, logComponent, 'Error trying to shield mined balance ' + JSON.stringify(result.error));
                    callback = function (){};
                    callback(true);
                }
                else {
                    opidCount++;
                    logger.special(logSystem, logComponent, 'Shield mined balance ' + amount);
                    callback = function (){};
                    callback(null);
                }
            }
        );
    }

    // send z_address balance to t_address
    function sendZToT (callback, zBalance) {
        if (callback === true)
            return;
        if ((zBalance - 10000) < 0)
            return;

        // do not allow more than a single z_sendmany operation at a time
        if (opidCount > 0) {
            logger.warning(logSystem, logComponent, 'sendZToT is waiting, too many z_sendmany operations already in progress.');
            return;
        }

        var amount = satoshisToCoins(zBalance - 10000);
        // unshield no more than 100 ZEC at a time
        if (amount > 100.0)
            amount = 100.0;

        var params = [poolOptions.zAddress, [{'address': poolOptions.tAddress, 'amount': amount}]];
        daemon.cmd('z_sendmany', params,
            function (result) {
                //Check if payments failed because wallet doesn't have enough coins to pay for tx fees
                if (result.error) {
                    logger.error(logSystem, logComponent, 'Error trying to send z_address coin balance to payout t_address.'
                        + JSON.stringify(result.error));
                    callback = function (){};
                    callback(true);
                }
                else {
                    opidCount++;
                    logger.special(logSystem, logComponent, 'Unshield funds for payout ' + amount);
                    callback = function (){};
                    callback(null);
                }
            }
        );
    }
    
    // TODO, this needs to be moved out of payments processor
    function cacheMarketStats() {
        var marketStatsUpdate = [];
        var coin = logComponent.replace('_testnet', '');
        request('https://api.coinmarketcap.com/v1/ticker/'+coin+'/', function (error, response, body) {
            if (error) {
                logger.error(logSystem, logComponent, 'Error getting coin market stats from CoinMarketCap ' + JSON.stringify(err));
                return;
            }
            if (response && response.statusCode) {
                if (response.statusCode == 200) {
                    if (body) {
                        var data = JSON.parse(body);
                        if (data.length > 0) {
                            marketStatsUpdate.push(['hset', coin + ':stats', 'coinmarketcap', JSON.stringify(data)]);
                            redisClient.multi(marketStatsUpdate).exec(function(err, results){
                                if (err){
                                    logger.error(logSystem, logComponent, 'Error update coin market stats to redis ' + JSON.stringify(err));
                                    return;
                                }
                            });
                        }
                    }
                } else {
                    logger.error(logSystem, logComponent, 'Error returned from coinmarketcap ' + JSON.stringify(response));
                }
            }
        });
    }

    // TODO, this needs to be moved out of payments processor
    function cacheNetworkStats () {
        var params = null;
        daemon.cmd('getmininginfo', params,
            function (result) {
                var finalRedisCommands = [];
                var coin = logComponent;

                if (result.error) {
                    logger.error(logSystem, logComponent, 'Error with RPC call `getmininginfo`'
                        + JSON.stringify(result.error));
                    return;
                } else {
                    if (result[0].response.blocks !== null) {
                        finalRedisCommands.push(['hset', coin + ':stats', 'networkBlocks', result[0].response.blocks]);
                        finalRedisCommands.push(['hset', coin + ':stats', 'networkDiff', result[0].response.difficulty]);
                        finalRedisCommands.push(['hset', coin + ':stats', 'networkSols', result[0].response.networkhashps]);
                    } else {
                        logger.error(logSystem, logComponent, "Error parse RPC call reponse.blocks tp `getmininginfo`." + JSON.stringify(result[0].response));
                    }
                }

                daemon.cmd('getnetworkinfo', params,
                    function (result) {
                        if (result.error) {
                            logger.error(logSystem, logComponent, 'Error with RPC call `getnetworkinfo`'
                                + JSON.stringify(result.error));
                            return;
                        } else {
                            if (result[0].response !== null) {
                                finalRedisCommands.push(['hset', coin + ':stats', 'networkConnections', result[0].response.connections]);
                                finalRedisCommands.push(['hset', coin + ':stats', 'networkVersion', result[0].response.version]);
                                finalRedisCommands.push(['hset', coin + ':stats', 'networkSubVersion', result[0].response.subversion]);
                                finalRedisCommands.push(['hset', coin + ':stats', 'networkProtocolVersion', result[0].response.protocolversion]);
                            } else {
                                logger.error(logSystem, logComponent, "Error parse RPC call response to `getnetworkinfo`." + JSON.stringify(result[0].response));
                            }
                        }
                        redisClient.multi(finalRedisCommands).exec(function(error, results){
                            if (error){
                                logger.error(logSystem, logComponent, 'Error update coin stats to redis ' + JSON.stringify(error));
                                return;
                            }
                        });
                    }
                );
            }
        );
    }

    // run coinbase coin transfers every x minutes
    var shieldIntervalState = 0; // do not send ZtoT and TtoZ and same time, this results in operation failed!
    var shielding_interval = poolOptions.walletInterval * 60 * 1000; // run every x minutes
    // shielding not required for some equihash coins
    if (requireShielding === true) {
        var shieldInterval = setInterval(function() {
            shieldIntervalState++;
            switch (shieldIntervalState) {
                case 1:
                    listUnspent(poolOptions.address, null, minConfShield, false, sendTToZ);
                    break;
                default:
                    listUnspentZ(poolOptions.zAddress, minConfShield, false, sendZToT);
                    shieldIntervalState = 0;
                    break;
            }
        }, shielding_interval);
    }
    
    // stats caching every 58 seconds
    var stats_interval = 58 * 1000;
    var statsInterval = setInterval(function() {
        // update network stats using coin daemon
        cacheNetworkStats();
        // update market stats using coinmarketcap
        if (getMarketStats === true) {
            cacheMarketStats();
        }
    }, stats_interval);

    // check operation statuses every 57 seconds
    var opid_interval =  57 * 1000;
    // shielding not required for some equihash coins
    if (requireShielding === true) {
        var checkOpids = function() {
            var checkOpIdSuccessAndGetResult = function(ops) {
                var batchRPC = [];
                ops.forEach(function(op, i){
                    if (op.status == "success" || op.status == "failed") {
                        batchRPC.push(['z_getoperationresult', [[op.id]]]);
                        if (opidCount > 0) {
                            opidCount = 0;
                        }
                        if (op.status == "failed") {
                            if (op.error) {
                              logger.error(logSystem, logComponent, "Shielding operation failed " + op.id + " " + op.error.code +", " + op.error.message);
                            } else {
                              logger.error(logSystem, logComponent, "Shielding operation failed " + op.id);
                            }
                        } else {
                            logger.special(logSystem, logComponent, 'Shielding operation success ' + op.id + '  txid: ' + op.result.txid);
                        }
                    } else if (op.status == "executing") {
                        if (opidCount == 0) {
                            opidCount++;
                            logger.special(logSystem, logComponent, 'Shielding operation in progress ' + op.id );
                        }
                    }
                });
                if (batchRPC.length <= 0) {
                    opidInterval = setInterval(checkOpids, opid_interval);
                    return;
                }
                daemon.batchCmd(batchRPC, function(error, results){
                    if (error || !results) {
                        logger.error(logSystem, logComponent, 'Error with z_getoperationresult ' + JSON.stringify(error));
                        return;
                    }
                    results.forEach(function(result, i) {
                        if (parseFloat(result.result[i].execution_secs || 0) > parseFloat(poolOptions.walletInterval))
                            logger.warning(logSystem, logComponent, 'Increase walletInterval in pool_config. opid execution took '+result.result[i].execution_secs+' secs.');
                    });
                    opidInterval = setInterval(checkOpids, opid_interval);
                });
            };
            clearInterval(opidInterval);
            daemon.cmd('z_getoperationstatus', null, function (result) {
              if (result.error) {
                logger.warning(logSystem, logComponent, 'Unable to get operation ids for clearing.');
                opidInterval = setInterval(checkOpids, opid_interval);
              } else if (result.response) {
                checkOpIdSuccessAndGetResult(result.response);
              } else {
                opidInterval = setInterval(checkOpids, opid_interval);
              }
            }, true, true);
        }
        
        var opidInterval = setInterval(checkOpids, opid_interval);
    }

    function roundTo(n, digits) {
        if (digits === undefined) {
            digits = 0;
        }
        var multiplicator = Math.pow(10, digits);
        n = parseFloat((n * multiplicator).toFixed(11));
        var test =(Math.round(n) / multiplicator);
        return +(test.toFixed(digits));
    }

    var satoshisToCoins = function(satoshis){
        return roundTo((satoshis / magnitude), coinPrecision);
    };

    var coinsToSatoshies = function(coins){
        return Math.round(coins * magnitude);
    };

    function coinsRound(number) {
        return roundTo(number, coinPrecision);
    }

    function checkForDuplicateBlockHeight(rounds, height) {
        var count = 0;
        for (var i = 0; i < rounds.length; i++) {
            if (rounds[i].height == height)
                count++;
        }
        return count > 1;
    }
    
    /* Deal with numbers in smallest possible units (satoshis) as much as possible. This greatly helps with accuracy
       when rounding and whatnot. When we are storing numbers for only humans to see, store in whole coin units. */

    var processPayments = function(){

        var startPaymentProcess = Date.now();

        var timeSpentRPC = 0;
        var timeSpentRedis = 0;

        var startTimeRedis;
        var startTimeRPC;

        var startRedisTimer = function(){ startTimeRedis = Date.now() };
        var endRedisTimer = function(){ timeSpentRedis += Date.now() - startTimeRedis };

        var startRPCTimer = function(){ startTimeRPC = Date.now(); };
        var endRPCTimer = function(){ timeSpentRPC += Date.now() - startTimeRedis };

        async.waterfall([
            /*
                Step 1 - build workers and rounds objects from redis
                         * removes duplicate block submissions from redis
            */
            function(callback){
                startRedisTimer();
                redisClient.multi([
                    ['hgetall', coin + ':balances'],
                    ['smembers', coin + ':blocksPending']
                ]).exec(function(error, results){
                    endRedisTimer();
                    if (error){
                        logger.error(logSystem, logComponent, 'Could not get blocks from redis ' + JSON.stringify(error));
                        callback(true);
                        return;
                    }
                    // build workers object from :balances
                    var workers = {};
                    for (var w in results[0]){
                        workers[w] = {balance: coinsToSatoshies(parseFloat(results[0][w]))};
                    }
                    // build rounds object from :blocksPending
                    var rounds = results[1].map(function(r){
                        var details = r.split(':');
                        return {
                            blockHash: details[0],
                            txHash: details[1],
                            height: details[2],
                            minedby: details[3],
                            duplicate: false,
                            serialized: r
                        };
                    });
                    // find duplicate blocks by height
                    // this can happen when two or more solutions are submitted at the same block height
                    var duplicateFound = false;
                    for (var i = 0; i < rounds.length; i++) {
                        if (checkForDuplicateBlockHeight(rounds, rounds[i].height) === true) {
                            rounds[i].duplicate = true;
                            duplicateFound = true;
                        }
                    }
                    // handle duplicates if needed
                    if (duplicateFound) {
                        var dups = rounds.filter(function(round){ return round.duplicate; });
                        logger.warning(logSystem, logComponent, 'Duplicate pending blocks found: ' + JSON.stringify(dups));
                        // attempt to find the invalid duplicates
                        var rpcDupCheck = dups.map(function(r){
                            return ['getblock', [r.blockHash]];
                        });
                        startRPCTimer();
                        daemon.batchCmd(rpcDupCheck, function(error, blocks){
                            endRPCTimer();
                            if (error || !blocks) {
                                logger.error(logSystem, logComponent, 'Error with duplicate block check rpc call getblock ' + JSON.stringify(error));
                                return;
                            }
                            // look for the invalid duplicate block
                            var validBlocks = {}; // hashtable for unique look up
                            var invalidBlocks = []; // array for redis work
                            blocks.forEach(function(block, i) {
                                if (block && block.result) {
                                    // invalid duplicate submit blocks have negative confirmations
                                    if (block.result.confirmations < 0) {
                                        logger.warning(logSystem, logComponent, 'Remove invalid duplicate block ' + block.result.height + ' > ' + block.result.hash);
                                        // move from blocksPending to blocksDuplicate...
                                        invalidBlocks.push(['smove', coin + ':blocksPending', coin + ':blocksDuplicate', dups[i].serialized]);
                                    } else {
                                        // block must be valid, make sure it is unique
                                        if (validBlocks.hasOwnProperty(dups[i].blockHash)) {
                                            // not unique duplicate block
                                            logger.warning(logSystem, logComponent, 'Remove non-unique duplicate block ' + block.result.height + ' > ' + block.result.hash);
                                            // move from blocksPending to blocksDuplicate...
                                            invalidBlocks.push(['smove', coin + ':blocksPending', coin + ':blocksDuplicate', dups[i].serialized]);                                            
                                        } else {
                                            // keep unique valid block
                                            validBlocks[dups[i].blockHash] = dups[i].serialized;
                                            logger.debug(logSystem, logComponent, 'Keep valid duplicate block ' + block.result.height + ' > ' + block.result.hash);
                                        }
                                    }
                                }
                            });
                            // filter out all duplicates to prevent double payments
                            rounds = rounds.filter(function(round){ return !round.duplicate; });
                            // if we detected the invalid duplicates, move them
                            if (invalidBlocks.length > 0) {                                
                                // move invalid duplicate blocks in redis
                                startRedisTimer();
                                redisClient.multi(invalidBlocks).exec(function(error, kicked){
                                    endRedisTimer();
                                    if (error) {
                                        logger.error(logSystem, logComponent, 'Error could not move invalid duplicate blocks in redis ' + JSON.stringify(error));
                                    }
                                    // continue payments normally
                                    callback(null, workers, rounds);
                                });
                            } else {
                                // notify pool owner that we are unable to find the invalid duplicate blocks, manual intervention required...
                                logger.error(logSystem, logComponent, 'Unable to detect invalid duplicate blocks, duplicate block payments on hold.');
                                // continue payments normally
                                callback(null, workers, rounds);                                
                            }
                        });
                    } else {
                        // no duplicates, continue payments normally
                        callback(null, workers, rounds);
                    }
                });
            },


            /* 
                Step 2 - check if mined block coinbase tx are ready for payment
                         * adds block reward to rounds object
                         * adds block confirmations count to rounds object
                         * updates confirmation counts in redis
            */
            function(workers, rounds, callback){
                // get pending block tx details
                var batchRPCcommand = rounds.map(function(r){
                    return ['gettransaction', [r.txHash]];
                });
                // get account address (not implemented at this time)
                batchRPCcommand.push(['getaccount', [poolOptions.address]]);

                startRPCTimer();
                daemon.batchCmd(batchRPCcommand, function(error, txDetails){
                    endRPCTimer();
                    if (error || !txDetails){
                        logger.error(logSystem, logComponent, 'Check finished - daemon rpc error with batch gettransactions ' + JSON.stringify(error));
                        callback(true);
                        return;
                    }

                    var confirmsUpdate = [];
                    var addressAccount = "";

                    // check for transaction errors and generated coins
                    txDetails.forEach(function(tx, i){
                        if (i === txDetails.length - 1){
                            if (tx.result && tx.result.toString().length > 0) {
                                addressAccount = tx.result.toString();
                            }
                            return;
                        }
                        var round = rounds[i];
                        // look for transaction errors
                        if (tx.error && tx.error.code === -5){
                            logger.warning(logSystem, logComponent, 'Daemon reports invalid transaction: ' + round.txHash);
                            round.category = 'kicked';
                            return;
                        }
                        else if (!tx.result.details || (tx.result.details && tx.result.details.length === 0)){
                            logger.warning(logSystem, logComponent, 'Daemon reports no details for transaction: ' + round.txHash);
                            round.category = 'kicked';
                            return;
                        }
                        else if (tx.error || !tx.result){
                            logger.error(logSystem, logComponent, 'Odd error with gettransaction ' + round.txHash + ' ' + JSON.stringify(tx));
                            return;
                        }
                        // get the coin base generation tx
                        var generationTx = tx.result.details.filter(function(tx){
                            return tx.address === poolOptions.address;
                        })[0];
                        if (!generationTx && tx.result.details.length === 1){
                            generationTx = tx.result.details[0];
                        }
                        if (!generationTx){
                            logger.error(logSystem, logComponent, 'Missing output details to pool address for transaction ' + round.txHash);
                            return;
                        }
                        // get transaction category for round
                        round.category = generationTx.category;
                        round.confirmations = parseInt((tx.result.confirmations || 0));
                        // get reward for newly generated blocks
                        if (round.category === 'generate') {
                            round.reward = coinsRound(parseFloat(generationTx.amount || generationTx.value));
                        }
                        // update confirmations in redis
                        confirmsUpdate.push(['hset', coin + ':blocksPendingConfirms', round.blockHash, round.confirmations]);
                    });

                    var canDeleteShares = function(r){
                        for (var i = 0; i < rounds.length; i++){
                            var compareR = rounds[i];
                            if ((compareR.height === r.height)
                                && (compareR.category !== 'kicked')
                                && (compareR.category !== 'orphan')
                                && (compareR.serialized !== r.serialized)){
                                return false;
                            }
                        }
                        return true;
                    };

                    // limit blocks paid per payment round
                    var payingBlocks = 0;
                    //filter out all rounds that are immature (not confirmed or orphaned yet)
                    rounds = rounds.filter(function(r){
                        // only pay max blocks at a time
                        if (payingBlocks >= maxBlocksPerPayment)
                            return false;

                        switch (r.category) {
                            case 'orphan':
                            case 'kicked':
                                r.canDeleteShares = canDeleteShares(r);
                                return true;                                        
                            case 'generate':
                                payingBlocks++;
                                return true;
                                
                            default:
                                return false;
                        }
                    });

                    // TODO: make tx fees dynamic
                    var feeSatoshi = coinsToSatoshies(fee);
                    // calculate what the pool owes its miners
                    var totalOwed = parseInt(0);
                    for (var i = 0; i < rounds.length; i++) {
                        // only pay generated blocks, not orphaned or kicked
                        if (rounds[i].category == 'generate') {
                            totalOwed = totalOwed + coinsToSatoshies(rounds[i].reward) - feeSatoshi;
                        }
                    }

                    var notAddr = null;
                    if (requireShielding === true) {
                        notAddr = poolOptions.address;
                    }
                    
                    // update confirmations for pending blocks in redis
                    if (confirmsUpdate.length > 0) {
                        startRedisTimer();
                        redisClient.multi(confirmsUpdate).exec(function(error, result){
                            endRedisTimer();
                            if (error) {
                                logger.error(logSystem, logComponent, 'Error could not update confirmations for pending blocks in redis ' + JSON.stringify(error));
                                return callback(true);
                            }
                            // check if we have enough tAddress funds to begin payment processing
                            listUnspent(null, notAddr, minConfPayout, false, function (error, tBalance){
                                if (error) {
                                    logger.error(logSystem, logComponent, 'Error checking pool balance before processing payments.');
                                    return callback(true);
                                } else if (tBalance < totalOwed) {
                                    logger.error(logSystem, logComponent,  'Insufficient funds ('+satoshisToCoins(tBalance) + ') to process payments (' + satoshisToCoins(totalOwed)+') for ' + payingBlocks + ' blocks; possibly waiting for txs.');
                                    return callback(true);
                                }
                                // account feature not implemented at this time
                                addressAccount = "";
                                // begin payments for generated coins
                                callback(null, workers, rounds, addressAccount);
                            });
                        });
                    } else {
                        // no pending blocks, need to find a block!
                        return callback(true);
                    }
                })
            },


            /* 
                Step 3 - lookup shares in redis and calculate rewards
            */
            function(workers, rounds, addressAccount, callback){
                // pplnt times lookup
                var timeLookups = rounds.map(function(r){
                    return ['hgetall', coin + ':shares:times' + r.height]
                });
                startRedisTimer();
                redisClient.multi(timeLookups).exec(function(error, allWorkerTimes){
                    endRedisTimer();
                    if (error){
                        callback('Check finished - redis error with multi get rounds time');
                        return;
                    }
                    var shareLookups = rounds.map(function(r){
                        return ['hgetall', coin + ':shares:round' + r.height];
                    });
                    startRedisTimer();
                    redisClient.multi(shareLookups).exec(function(error, allWorkerShares){
                        endRedisTimer();
                        if (error){
                            callback('Check finished - redis error with multi get rounds share');
                            return;
                        }

                        // error detection
                        var err = null;

                        // total shares
                        rounds.forEach(function(round, i){
                            var workerShares = allWorkerShares[i];                            
                            if (!workerShares){
                                err = true;
                                logger.error(logSystem, logComponent, 'No worker shares for round: ' + round.height + ' blockHash: ' + round.blockHash);
                                return;
                            }
                            var workerTimes = allWorkerTimes[i];
                            switch (round.category){
                                case 'kicked':
                                case 'orphan':
                                    round.workerShares = workerShares;
                                    break;
                                case 'generate':
                                    // TODO: make tx fees dynamic
                                    var feeSatoshi = coinsToSatoshies(fee);
                                    var reward = coinsToSatoshies(round.reward) - feeSatoshi;
                                    var totalShares = parseFloat(0);
                                    var sharesLost = parseFloat(0);
                                    // find most time spent in this round by single worker
                                    maxTime = 0;
                                    for (var workerAddress in workerTimes){
                                        if (maxTime < parseFloat(workerTimes[workerAddress]))
                                            maxTime = parseFloat(workerTimes[workerAddress]);
                                    }
                                    // total up shares for round
                                    for (var workerAddress in workerShares){
                                        var worker = workers[workerAddress] = (workers[workerAddress] || {});
                                        var shares = parseFloat((workerShares[workerAddress] || 0));
                                        // if pplnt mode
                                        if (pplntEnabled === true && maxTime > 0) {
                                            var tshares = shares;
                                            var lost = parseFloat(0);
                                            var address = workerAddress.split('.')[0];
                                            if (workerTimes[address] != null && parseFloat(workerTimes[address]) > 0) {
                                                var timePeriod = roundTo(parseFloat(workerTimes[address] || 1) / maxTime , 2);
                                                if (timePeriod > 0 && timePeriod < pplntTimeQualify) {
                                                    var lost = shares - (shares * timePeriod);
                                                    sharesLost += lost;
                                                    shares = Math.max(shares - lost, 0);
                                                    logger.warning(logSystem, logComponent, 'PPLNT: Reduced shares for '+workerAddress+' round:' + round.height + ' maxTime:'+maxTime+'sec timePeriod:'+roundTo(timePeriod,6)+' shares:'+tshares+' lost:'+lost+' new:'+shares);
                                                }
                                                if (timePeriod > 1.0) {
                                                    err = true;
                                                    logger.error(logSystem, logComponent, 'Time share period is greater than 1.0 for '+workerAddress+' round:' + round.height + ' blockHash:' + round.blockHash);
                                                    return;                                                    
                                                }
                                            } else {
                                                logger.warning(logSystem, logComponent, 'PPLNT: Missing time share period for '+workerAddress+', miner shares qualified in round ' + round.height);
                                            }
                                        }
                                        worker.roundShares = shares;
                                        worker.totalShares = parseFloat(worker.totalShares || 0) + shares;
                                        totalShares += shares;
                                    }
                                    
                                    //console.log('--REWARD DEBUG--------------');
                                    // calculate rewards for round
                                    var totalAmount = 0;
                                    for (var workerAddress in workerShares){
                                        var worker = workers[workerAddress] = (workers[workerAddress] || {});
                                        var percent = parseFloat(worker.roundShares) / totalShares;
                                        if (percent > 1.0) {
                                            err = true;
                                            logger.error(logSystem, logComponent, 'Share percent is greater than 1.0 for '+workerAddress+' round:' + round.height + ' blockHash:' + round.blockHash);
                                            return;
                                        }
                                        // calculate workers reward for this round
                                        var workerRewardTotal = Math.round(reward * percent);                                        
                                        // add to total reward for worker
                                        worker.reward = (worker.reward || 0) + workerRewardTotal;
                                        // add to total amount sent to all workers
                                        totalAmount += worker.reward;
                                        //console.log('rewardAmount: '+workerAddress+' '+workerRewardTotal);
                                        //console.log('totalAmount: '+workerAddress+' '+worker.reward);
                                    }
                                    //console.log('totalAmount: '+totalAmount);
                                    //console.log('blockHeight: '+round.height);
                                    //console.log('blockReward: '+reward);
                                    //console.log('totalShares: '+totalShares);
                                    //console.log('sharesLost: '+sharesLost);
                                    //console.log('----------------------------');
                                    break;
                            }
                        });
                        
                        // if there was no errors
                        if (err === null) {
                            // continue payments
                            callback(null, workers, rounds, addressAccount);
                        } else {
                            // stop waterfall flow, do not process payments
                            callback(true);
                        }
                    });
                
                });

            },

            
            /*
               Step 4 - Generate RPC commands to send payments
               When deciding the sent balance, it the difference should be -1*amount they had in db,
               If not sending the balance, the differnce should be +(the amount they earned this round)
            */
            function(workers, rounds, addressAccount, callback) {

                var trySend = function (withholdPercent) {
                    var addressAmounts = {};
                    var balanceAmounts = {};
                    var shareAmounts = {};
                    var minerTotals = {};
                    var totalSent = 0;
                    var totalShares = 0;
                    // total up miner's balances
                    for (var w in workers) {
                        var worker = workers[w];
                        totalShares += (worker.totalShares || 0)
                        worker.balance = worker.balance || 0;
                        worker.reward = worker.reward || 0;
                        // get miner payout totals
                        var toSendSatoshis = Math.round((worker.balance + worker.reward) * (1 - withholdPercent));
                        var address = worker.address = (worker.address || getProperAddress(w.split('.')[0]));
                        if (minerTotals[address] != null && minerTotals[address] > 0) {
                            minerTotals[address] += toSendSatoshis;
                        } else {
                            minerTotals[address] = toSendSatoshis;
                        }
                    }
                    // now process each workers balance, and pay the miner
                    for (var w in workers) {
                        var worker = workers[w];
                        worker.balance = worker.balance || 0;
                        worker.reward = worker.reward || 0;
                        var toSendSatoshis = Math.round((worker.balance + worker.reward) * (1 - withholdPercent));
                        var address = worker.address = (worker.address || getProperAddress(w.split('.')[0]));
                        // if miners total is enough, go ahead and add this worker balance
                        if (minerTotals[address] >= minPaymentSatoshis) {
                            totalSent += toSendSatoshis;
                            // send funds
                            worker.sent = satoshisToCoins(toSendSatoshis);
                            worker.balanceChange = Math.min(worker.balance, toSendSatoshis) * -1;
                            // multiple workers may have same address, add them up
                            if (addressAmounts[address] != null && addressAmounts[address] > 0) {
                                addressAmounts[address] = coinsRound(addressAmounts[address] + worker.sent);
                            } else {
                                addressAmounts[address] = worker.sent;
                            }
                        } else {
                            // add to balance, not enough minerals
                            worker.sent = 0;
                            worker.balanceChange = Math.max(toSendSatoshis - worker.balance, 0);
                            // track balance changes
                            if (worker.balanceChange > 0) {
                                if (balanceAmounts[address] != null && balanceAmounts[address] > 0) {
                                    balanceAmounts[address] = coinsRound(balanceAmounts[address] + satoshisToCoins(worker.balanceChange));
                                } else {
                                    balanceAmounts[address] = satoshisToCoins(worker.balanceChange);
                                }
                            }
                        }
                        // track share work
                        if (worker.totalShares > 0) {
                            if (shareAmounts[address] != null && shareAmounts[address] > 0) {
                                shareAmounts[address] += worker.totalShares;
                            } else {
                                shareAmounts[address] = worker.totalShares;
                            }
                        }
                    }

                    // if no payouts...continue to next set of callbacks
                    if (Object.keys(addressAmounts).length === 0){
                        callback(null, workers, rounds);
                        return;
                    }
                    
                    // POINT OF NO RETURN! GOOD LUCK!
                    // WE ARE SENDING PAYMENT CMD TO DAEMON
                    
                    // perform the sendmany operation .. addressAccount
                    daemon.cmd('sendmany', ["", addressAmounts], function (result) {
                        // check for failed payments, there are many reasons
                        if (result.error && result.error.code === -6) {
                            // we thought we had enough funds to send payments, but apparently not...
                            // try decreasing payments by a small percent to cover unexpected tx fees?
                            var higherPercent = withholdPercent + 0.001;
                            logger.warning(logSystem, logComponent, 'Not enough funds to cover the tx fees for sending out payments, decreasing rewards by ' + (higherPercent * 100) + '% and retrying');
                            trySend(higherPercent);
                            //callback(true); not a complete failure...
                            return;
                        }
                        else if (result.error && result.error.code === -5) {
                            // invalid address specified in addressAmounts array
                            logger.error(logSystem, logComponent, 'Error sending payments ' + result.error.message);
                            // payment failed, prevent updates to redis
                            callback(true);
                            return;
                        }
                        else if (result.error && result.error.message != null) {
                            // error from daemon
                            logger.error(logSystem, logComponent, 'Error sending payments ' + result.error.message);
                            // payment failed, prevent updates to redis
                            callback(true);
                            return;
                        }
                        else if (result.error) {
                            // unknown error
                            logger.error(logSystem, logComponent, 'Error sending payments ' + JSON.stringify(result.error));
                            // payment failed, prevent updates to redis
                            callback(true);
                            return;
                        }
                        else {

                            // make sure sendmany gives us back a txid
                            var txid = null;
                            if (result.response) {
                                txid = result.response;
                            }
                            if (txid != null) {

                                // it worked, congrats on your pools payout ;)
                                logger.special(logSystem, logComponent, 'Sent ' + satoshisToCoins(totalSent)
                                    + ' to ' + Object.keys(addressAmounts).length + ' miners; txid: '+txid);

                                if (withholdPercent > 0) {
                                    logger.warning(logSystem, logComponent, 'Had to withhold ' + (withholdPercent * 100)
                                        + '% of reward from miners to cover transaction fees. '
                                        + 'Fund pool wallet with coins to prevent this from happening');
                                }

                                // save payments data to redis
                                var paymentBlocks = rounds.filter(function(r){ return r.category == 'generate'; }).map(function(r){
                                    return parseInt(r.height);
                                });
                                
                                var paymentsUpdate = [];
                                var paymentsData = {time:Date.now(), txid:txid, shares:totalShares, paid:satoshisToCoins(totalSent),  miners:Object.keys(addressAmounts).length, blocks: paymentBlocks, amounts: addressAmounts, balances: balanceAmounts, work:shareAmounts};
                                paymentsUpdate.push(['zadd', logComponent + ':payments', Date.now(), JSON.stringify(paymentsData)]);
                                startRedisTimer();
                                redisClient.multi(paymentsUpdate).exec(function(error, payments){
                                    endRedisTimer();
                                    if (error){
                                        logger.error(logSystem, logComponent, 'Error redis save payments data ' + JSON.stringify(payments));
                                    }
                                    // perform final redis updates
                                    callback(null, workers, rounds);
                                });

                            } else {

                                clearInterval(paymentInterval);

                                logger.error(logSystem, logComponent, 'Error RPC sendmany did not return txid '
                                    + JSON.stringify(result) + 'Disabling payment processing to prevent possible double-payouts.');

                                callback(true);
                                return;
                            }
                        }
                    }, true, true);
                };

                trySend(0);

            },


            /*
                Step 5 - Final redis commands
            */
            function(workers, rounds, callback){

                var totalPaid = parseFloat(0);

                var balanceUpdateCommands = [];
                var workerPayoutsCommand = [];

                // update worker paid/balance stats
                for (var w in workers) {
                    var worker = workers[w];
                    if (worker.balanceChange !== 0){
                        balanceUpdateCommands.push([
                            'hincrbyfloat',
                            coin + ':balances',
                            w,
                            satoshisToCoins(worker.balanceChange)
                        ]);
                    }
                    if (worker.sent !== 0){
                        workerPayoutsCommand.push(['hincrbyfloat', coin + ':payouts', w, coinsRound(worker.sent)]);
                        totalPaid = coinsRound(totalPaid + worker.sent);
                    }
                }

                var movePendingCommands = [];
                var roundsToDelete = [];
                var orphanMergeCommands = [];
                var confirmsToDelete = [];
                
                var moveSharesToCurrent = function(r){
                    var workerShares = r.workerShares;
                    if (workerShares != null) {
                        Object.keys(workerShares).forEach(function(worker){
                            orphanMergeCommands.push(['hincrby', coin + ':shares:roundCurrent', worker, workerShares[worker]]);
                        });
                    }
                };

                // handle the round
                rounds.forEach(function(r){
                    switch(r.category){
                        case 'kicked':
                            confirmsToDelete.push(['hdel', coin + ':blocksPendingConfirms', r.blockHash]);
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksKicked', r.serialized]);
                        case 'orphan':
                            confirmsToDelete.push(['hdel', coin + ':blocksPendingConfirms', r.blockHash]);
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksOrphaned', r.serialized]);
                            if (r.canDeleteShares){
                                moveSharesToCurrent(r);
                                roundsToDelete.push(coin + ':shares:round' + r.height);
                                roundsToDelete.push(coin + ':shares:times' + r.height);
                            }
                            return;
                        case 'generate':
                            confirmsToDelete.push(['hdel', coin + ':blocksPendingConfirms', r.blockHash]);
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksConfirmed', r.serialized]);
                            roundsToDelete.push(coin + ':shares:round' + r.height);
                            roundsToDelete.push(coin + ':shares:times' + r.height);
                            return;
                    }
                });

                var finalRedisCommands = [];

                if (movePendingCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(movePendingCommands);

                if (orphanMergeCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(orphanMergeCommands);

                if (balanceUpdateCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(balanceUpdateCommands);

                if (workerPayoutsCommand.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(workerPayoutsCommand);

                if (roundsToDelete.length > 0)
                    finalRedisCommands.push(['del'].concat(roundsToDelete));

                if (confirmsToDelete.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(confirmsToDelete);
                
                if (totalPaid !== 0)
                    finalRedisCommands.push(['hincrbyfloat', coin + ':stats', 'totalPaid', totalPaid]);

                if (finalRedisCommands.length === 0){
                    callback();
                    return;
                }

                startRedisTimer();
                redisClient.multi(finalRedisCommands).exec(function(error, results){
                    endRedisTimer();
                    if (error) {                        
                        clearInterval(paymentInterval);
                        
                        logger.error(logSystem, logComponent,
                                'Payments sent but could not update redis. ' + JSON.stringify(error)
                                + ' Disabling payment processing to prevent possible double-payouts. The redis commands in '
                                + coin + '_finalRedisCommands.txt must be ran manually');
                                
                        fs.writeFile(coin + '_finalRedisCommands.txt', JSON.stringify(finalRedisCommands), function(err){
                            logger.error('Could not write finalRedisCommands.txt, you are fucked.');
                        });
                    }
                    callback();
                });
            }

        ], function(){

            var paymentProcessTime = Date.now() - startPaymentProcess;
            logger.debug(logSystem, logComponent, 'Finished interval - time spent: '
                + paymentProcessTime + 'ms total, ' + timeSpentRedis + 'ms redis, '
                + timeSpentRPC + 'ms daemon RPC');

        });
    };


    var getProperAddress = function(address){
        if (address.length === 40){
            return util.addressFromEx(poolOptions.address, address);
        }
        else return address;
    };

}
