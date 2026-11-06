// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {DeployRegistry} from "../src/DeployRegistry.sol";
import {DeployAttestations} from "../src/DeployAttestations.sol";
import {RefRegistry} from "../src/RefRegistry.sol";

interface VmS {
    function startBroadcast(uint256) external;
    function stopBroadcast() external;
    function envUint(string calldata) external view returns (uint256);
    function envOr(string calldata, address) external view returns (address);
    function addr(uint256) external view returns (address);
}

/// cd packages/contracts && forge script script/Deploy.s.sol:Deploy --rpc-url $L1_RPC_URL --broadcast
/// Env: DHEET_DEPLOYER_KEY (hex uint).
///   RELAYER   (optional) worker wallet (DHEET_PRIVATE_KEY's address); gets WRITER + FORCE_PUSH on the RefRegistry.
///   FORWARDER (optional) Chainlink KeystoneForwarder; DeployAttestations is only deployed when set.
contract Deploy {
    VmS internal constant vm = VmS(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function run() external returns (DeployRegistry reg, RefRegistry refs, DeployAttestations att) {
        uint256 pk = vm.envUint("DHEET_DEPLOYER_KEY");
        address relayer = vm.envOr("RELAYER", address(0));
        address forwarder = vm.envOr("FORWARDER", address(0));
        address me = vm.addr(pk);
        vm.startBroadcast(pk);
        reg = new DeployRegistry(me);
        reg.setPublisher(me, true);
        refs = new RefRegistry(me);
        if (relayer != address(0) && relayer != me) {
            refs.setRole(refs.WRITER_ROLE(), relayer, true);
            refs.setRole(refs.FORCE_PUSH_ROLE(), relayer, true);
        }
        if (forwarder != address(0)) att = new DeployAttestations(me, forwarder, address(reg));
        vm.stopBroadcast();
    }
}
