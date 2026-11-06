// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {DeployRegistry} from "../src/DeployRegistry.sol";
import {DeployAttestations, IReceiver, IERC165} from "../src/DeployAttestations.sol";

interface VmA {
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectEmit(bool, bool, bool, bool, address) external;
}

contract DeployAttestationsTest {
    VmA internal constant vm = VmA(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    event Attested(uint256 indexed releaseId, bytes32 indexed bundleHash, bool ok, uint64 observedAt);

    address internal constant OWNER = address(0xA11CE);
    address internal constant FWD = address(0xF00D);
    address internal constant FWD2 = address(0xF00E);
    bytes32 internal constant C = bytes32(uint256(0xc0));
    bytes32 internal constant B = bytes32(uint256(0xb0));

    DeployRegistry internal reg;
    DeployAttestations internal att;

    function setUp() public {
        reg = new DeployRegistry(OWNER);
        vm.prank(OWNER);
        reg.setPublisher(address(this), true);
        reg.publish(C, B, "u1");
        att = new DeployAttestations(OWNER, FWD, address(reg));
    }

    function _report(uint256 id, bytes32 c, bytes32 b, bool ok, uint64 t)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(id, c, b, ok, t);
    }

    function testConstructorGuards() public {
        vm.expectRevert(DeployAttestations.ZeroAddress.selector);
        new DeployAttestations(OWNER, address(0), address(reg));
        vm.expectRevert(DeployAttestations.ZeroAddress.selector);
        new DeployAttestations(address(0), FWD, address(reg));
        vm.expectRevert(DeployAttestations.ZeroAddress.selector);
        new DeployAttestations(OWNER, FWD, address(0));
    }

    function testOnlyForwarderCanReport() public {
        bytes memory r = _report(1, C, B, true, 100);
        vm.expectRevert(abi.encodeWithSelector(DeployAttestations.InvalidSender.selector, address(this), FWD));
        att.onReport("", r);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(DeployAttestations.InvalidSender.selector, OWNER, FWD));
        att.onReport("", r);
    }

    function testStoresAndEmits() public {
        vm.expectEmit(true, true, false, true, address(att));
        emit Attested(1, B, true, 100);
        vm.prank(FWD);
        att.onReport("meta", _report(1, C, B, true, 100));

        (bool exists, bool ok, uint64 t, uint256 n) = att.attestation(1);
        require(exists && ok && t == 100 && n == 1, "stored");
        require(att.lastMetadataHash(1) == keccak256("meta"), "meta");
        (uint256 id, bool ok2, uint64 t2) = att.latestAttestation();
        require(id == 1 && ok2 && t2 == 100, "latest");
    }

    function testUnattestedView() public view {
        (bool exists,,, uint256 n) = att.attestation(1);
        require(!exists && n == 0, "none");
        (uint256 id,,) = att.latestAttestation();
        require(id == 0, "latest none");
    }

    function testRejectsUnknownRelease() public {
        vm.prank(FWD);
        vm.expectRevert(abi.encodeWithSelector(DeployAttestations.UnknownRelease.selector, 2));
        att.onReport("", _report(2, C, B, true, 1));
        vm.prank(FWD);
        vm.expectRevert(abi.encodeWithSelector(DeployAttestations.UnknownRelease.selector, 0));
        att.onReport("", _report(0, C, B, true, 1));
    }

    function testRejectsMismatch() public {
        vm.prank(FWD);
        vm.expectRevert(abi.encodeWithSelector(DeployAttestations.ReleaseMismatch.selector, 1));
        att.onReport("", _report(1, bytes32(uint256(9)), B, true, 1));
        vm.prank(FWD);
        vm.expectRevert(abi.encodeWithSelector(DeployAttestations.ReleaseMismatch.selector, 1));
        att.onReport("", _report(1, C, bytes32(uint256(9)), true, 1));
    }

    function testRepeatAttestationIncrementsCountAndOverwrites() public {
        vm.prank(FWD);
        att.onReport("m1", _report(1, C, B, true, 100));
        vm.prank(FWD);
        att.onReport("m2", _report(1, C, B, false, 200));
        (bool exists, bool ok, uint64 t, uint256 n) = att.attestation(1);
        require(exists && !ok && t == 200 && n == 2, "repeat");
        require(att.lastMetadataHash(1) == keccak256("m2"), "meta2");
        // exact replay does not revert; it is just counted
        vm.prank(FWD);
        att.onReport("m2", _report(1, C, B, false, 200));
        (,,, n) = att.attestation(1);
        require(n == 3, "replay counted");
    }

    function testLatestTracksHighestRelease() public {
        reg.publish(bytes32(uint256(5)), bytes32(uint256(6)), "u2");
        vm.prank(FWD);
        att.onReport("", _report(2, bytes32(uint256(5)), bytes32(uint256(6)), true, 50));
        vm.prank(FWD);
        att.onReport("", _report(1, C, B, false, 60));
        (uint256 id, bool ok, uint64 t) = att.latestAttestation();
        require(id == 2 && ok && t == 50, "highest");
    }

    function testMalformedReportReverts() public {
        vm.prank(FWD);
        vm.expectRevert();
        att.onReport("", hex"1234");
    }

    function testSetForwarder() public {
        vm.prank(OWNER);
        att.setForwarder(FWD2);
        require(att.forwarder() == FWD2, "set");
        vm.prank(FWD);
        vm.expectRevert(abi.encodeWithSelector(DeployAttestations.InvalidSender.selector, FWD, FWD2));
        att.onReport("", _report(1, C, B, true, 1));
        vm.prank(FWD2);
        att.onReport("", _report(1, C, B, true, 1));
    }

    function testSetForwarderGuards() public {
        vm.expectRevert(DeployAttestations.NotOwner.selector);
        att.setForwarder(FWD2);
        vm.prank(OWNER);
        vm.expectRevert(DeployAttestations.ZeroAddress.selector);
        att.setForwarder(address(0));
    }

    function testERC165() public view {
        require(att.supportsInterface(type(IReceiver).interfaceId), "ireceiver");
        require(att.supportsInterface(type(IERC165).interfaceId), "erc165");
        require(!att.supportsInterface(0xffffffff), "ffffffff");
        require(!att.supportsInterface(0xdeadbeef), "other");
        require(type(IReceiver).interfaceId == IReceiver.onReport.selector, "id");
    }
}
