// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {DeployRegistry} from "../src/DeployRegistry.sol";
import {DeployAttestations} from "../src/DeployAttestations.sol";

interface VmS {
    function startBroadcast(uint256) external;
    function stopBroadcast() external;
    function envUint(string calldata) external view returns (uint256);
    function envAddress(string calldata) external view returns (address);
    function addr(uint256) external view returns (address);
}

/// forge script script/Deploy.s.sol --root packages/contracts --rpc-url $SEPOLIA_RPC_URL --broadcast
/// Env: DHEET_DEPLOYER_KEY (hex uint), optional FORWARDER.
contract Deploy {
    VmS internal constant vm = VmS(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function run() external returns (DeployRegistry reg, DeployAttestations att) {
        uint256 pk = vm.envUint("DHEET_DEPLOYER_KEY");
        address forwarder = vm.envAddress("FORWARDER");
        address me = vm.addr(pk);
        vm.startBroadcast(pk);
        reg = new DeployRegistry(me);
        reg.setPublisher(me, true);
        att = new DeployAttestations(me, forwarder, address(reg));
        vm.stopBroadcast();
    }
}
