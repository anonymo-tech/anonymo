// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice Integral checkpoints for a trailing seven-day average. Time before the first checkpoint counts as zero.
library StakeTwab {
    uint256 internal constant WINDOW = 7 days;

    struct Checkpoint {
        uint48 time;
        uint208 balance; // balance from `time` on
        uint256 cumulative; // integral of balance dt from 0 to `time`
    }

    function write(Checkpoint[] storage cps, uint256 balance) internal {
        uint256 n = cps.length;
        uint48 now_ = SafeCast.toUint48(block.timestamp);
        uint208 bal = SafeCast.toUint208(balance);
        if (n != 0) {
            Checkpoint storage last = cps[n - 1];
            if (last.time == now_) {
                last.balance = bal;
                return;
            }
            uint256 cum = last.cumulative + uint256(last.balance) * (now_ - last.time);
            cps.push(Checkpoint(now_, bal, cum));
        } else {
            cps.push(Checkpoint(now_, bal, 0));
        }
    }

    /// @dev Integral of balance dt from 0 to `t`.
    function _cumulative(Checkpoint[] storage cps, uint256 t) private view returns (uint256) {
        uint256 n = cps.length;
        if (n == 0 || t < cps[0].time) return 0;
        // Last checkpoint with time <= t.
        uint256 lo = 0;
        uint256 hi = n - 1;
        if (cps[hi].time > t) {
            while (lo < hi) {
                uint256 mid = (lo + hi + 1) / 2;
                if (cps[mid].time <= t) lo = mid;
                else hi = mid - 1;
            }
        } else {
            lo = hi;
        }
        Checkpoint storage c = cps[lo];
        return c.cumulative + uint256(c.balance) * (t - c.time);
    }

    function average(Checkpoint[] storage cps, uint256 t) internal view returns (uint256) {
        uint256 start = t > WINDOW ? t - WINDOW : 0;
        return (_cumulative(cps, t) - _cumulative(cps, start)) / WINDOW;
    }
}
