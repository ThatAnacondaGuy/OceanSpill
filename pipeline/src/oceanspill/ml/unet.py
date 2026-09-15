from __future__ import annotations

try:
    import torch
    from torch import nn
    import torch.nn.functional as F
except ImportError as exc:  # pragma: no cover - depends on optional extra
    raise ImportError("the U-Net needs the 'ml' extra: uv sync --extra ml --extra sar") from exc


class DoubleConv(nn.Sequential):
    def __init__(self, cin: int, cout: int):
        super().__init__(
            nn.Conv2d(cin, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
            nn.Conv2d(cout, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
        )


class UNet(nn.Module):
    """U-Net (Ronneberger et al. 2015) for binary oil segmentation of dual-polarisation SAR tiles."""

    def __init__(self, in_channels: int = 2, base: int = 32, depth: int = 4):
        super().__init__()
        chans = [base * 2**i for i in range(depth + 1)]
        self.down = nn.ModuleList([DoubleConv(in_channels, chans[0])] + [DoubleConv(chans[i], chans[i + 1]) for i in range(depth)])
        self.up = nn.ModuleList([nn.ConvTranspose2d(chans[i + 1], chans[i], 2, stride=2) for i in reversed(range(depth))])
        self.merge = nn.ModuleList([DoubleConv(chans[i] * 2, chans[i]) for i in reversed(range(depth))])
        self.head = nn.Conv2d(chans[0], 1, 1)

    def forward(self, x: "torch.Tensor") -> "torch.Tensor":
        skips = []
        for i, block in enumerate(self.down):
            x = block(x if i == 0 else F.max_pool2d(x, 2))
            skips.append(x)
        x = skips.pop()
        for up, merge in zip(self.up, self.merge):
            skip = skips.pop()
            x = up(x)
            if x.shape[-2:] != skip.shape[-2:]:
                x = F.interpolate(x, size=skip.shape[-2:], mode="bilinear", align_corners=False)
            x = merge(torch.cat([skip, x], dim=1))
        return self.head(x)


class DiceFocalLoss(nn.Module):
    """Soft Dice plus focal loss: Dice handles the extreme class imbalance, focal sharpens hard pixels."""

    def __init__(self, alpha: float = 0.75, gamma: float = 2.0, dice_weight: float = 1.0):
        super().__init__()
        self.alpha, self.gamma, self.dice_weight = alpha, gamma, dice_weight

    def forward(self, logits: "torch.Tensor", target: "torch.Tensor") -> "torch.Tensor":
        prob = torch.sigmoid(logits)
        bce = F.binary_cross_entropy_with_logits(logits, target, reduction="none")
        pt = torch.where(target > 0.5, prob, 1 - prob)
        alpha = torch.where(target > 0.5, torch.full_like(prob, self.alpha), torch.full_like(prob, 1 - self.alpha))
        focal = (alpha * (1 - pt) ** self.gamma * bce).mean()
        dims = (1, 2, 3)
        inter = (prob * target).sum(dims)
        dice = 1 - (2 * inter + 1) / (prob.sum(dims) + target.sum(dims) + 1)
        return focal + self.dice_weight * dice.mean()
