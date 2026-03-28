import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, BookText, Copy, FileCode2, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const IMPORT_STORAGE_KEY = "macro_editor_import_script";

type Section = {
    title: string;
    description: string;
    syntax?: string;
    useCase?: string;
    example?: string;
};

type Recipe = {
    title: string;
    description: string;
    script: string;
};

type MacroAsset = {
    name: string;
    url: string;
    region?: { x: number; y: number; width: number; height: number };
};

const sections: Section[] = [
    {
        title: "Quy tac co ban",
        description: "Moi dong la mot lenh. Cho phep dong trong. Dong bat dau bang # hoac // se duoc xem la comment.",
        syntax: "# comment",
        useCase: "Dung de ghi chu cho script de de doc va de debug.",
        example: `# Mo app va bam vao nut dang nhap
WAIT 500
TAP 540 1680
KEY BACK`,
    },
    {
        title: "WAIT",
        description: "Dung script theo mili giay.",
        syntax: "WAIT <milliseconds>",
        useCase: "Dung sau khi mo popup, swipe, back, hoac bat ky thao tac nao can doi UI on dinh.",
        example: `WAIT 1000`,
    },
    {
        title: "TAP",
        description: "Tap vao mot toa do co dinh tren man hinh thiet bi.",
        syntax: "TAP <x> <y>",
        useCase: "Dung khi toa do co dinh va ban da biet chac diem can bam.",
        example: `TAP 540 1680`,
    },
    {
        title: "DRAG",
        description: "Keo tu diem dau toi diem cuoi trong mot khoang thoi gian. Dung cho swipe hoac gesture don gian.",
        syntax: "DRAG <x1> <y1> <x2> <y2> <durationMs>",
        useCase: "Dung de swipe len/xuong/trai/phai hoac mo phong gesture co huong.",
        example: `DRAG 540 1700 540 600 350`,
    },
    {
        title: "KEY",
        description: "Gui phim Android. Ho tro: HOME, BACK, POWER, RECENTS, APP_SWITCH.",
        syntax: "KEY <HOME|BACK|POWER|RECENTS|APP_SWITCH>",
        useCase: "Dung khi can quay lai, ve home, tat/man hinh, hoac goi recent apps.",
        example: `KEY HOME`,
    },
    {
        title: "IF PIXEL",
        description: "Kiem tra mau tai mot pixel. TOL la sai so mau, mac dinh la 12 neu khong ghi.",
        syntax: "IF PIXEL <x> <y> == <#RRGGBB> TOL <n>",
        useCase: "Dung khi UI co mot diem mau rat on dinh, nhanh hon image match.",
        example: `IF PIXEL 120 220 == #FFFFFF TOL 16
  TAP 540 1680
ELSE
  WAIT 500
END`,
    },
    {
        title: "IF IMAGE",
        description: "Tim anh tren frame hien tai. Neu thay anh thi chay block phia duoi. Co the dat nguong CONF va chon FAST/PRECISE.",
        syntax: "IF IMAGE \"<asset-url>\" CONF >= <threshold> [FAST|PRECISE]",
        useCase: "Dung khi can phat hien mot icon, button, popup, item, hoac logo tren man hinh. FAST uu tien toc do, PRECISE uu tien do chac.",
        example: `IF IMAGE "/api/macros/assets/start-button.png" CONF >= 0.92
  TAP_MATCH
ELSE
  WAIT 1000
END`,
    },
    {
        title: "IF IMAGE + REGION",
        description: "Chi tim anh trong mot vung nho de nhanh hon va on dinh hon. Co the ket hop voi FAST/PRECISE.",
        syntax: "IF IMAGE \"<asset-url>\" CONF >= <threshold> REGION <x> <y> <width> <height> [FAST|PRECISE]",
        useCase: "Dung khi ban biet anh chi xuat hien trong mot khu vuc cu the nhu goc tren phai, footer, hoac ben trong popup.",
        example: `IF IMAGE "/api/macros/assets/popup-close.png" CONF >= 0.9 REGION 700 100 300 300 FAST
  TAP_MATCH
END`,
    },
    {
        title: "FAST",
        description: "Mode match nhanh hon. Thu it scale hon va uu tien toc do.",
        syntax: "IF IMAGE \"<asset-url>\" CONF >= 0.9 FAST",
        useCase: "Dung cho icon nho, on dinh, crop gon, vi du nut close, icon menu, button co hinh dang ro.",
        example: `IF IMAGE "/api/macros/assets/menu.png" CONF >= 0.9 FAST
  TAP_MATCH
END`,
    },
    {
        title: "PRECISE",
        description: "Mode match ky hon. Thu them scale va quet chat hon de tang do chac.",
        syntax: "IF IMAGE \"<asset-url>\" CONF >= 0.9 PRECISE",
        useCase: "Dung cho anh kho hon, banner, popup lon, hoac UI co thay doi nhe ve scale.",
        example: `IF IMAGE "/api/macros/assets/banner.png" CONF >= 0.9 PRECISE
  TAP_MATCH
END`,
    },
    {
        title: "TAP_MATCH",
        description: "Tap vao tam cua anh vua match thanh cong gan nhat. Dung ben trong IF IMAGE.",
        syntax: "TAP_MATCH",
        useCase: "Dung ngay sau IF IMAGE khi muon bam vao chinh anh vua tim thay.",
        example: `IF IMAGE "/api/macros/assets/login.png" CONF >= 0.9
  TAP_MATCH
END`,
    },
    {
        title: "TAP_MATCH OFFSET",
        description: "Tap lech khoi tam anh mot chut theo X/Y. Huu ich khi muon bam mep icon hoac tranh de vao text.",
        syntax: "TAP_MATCH OFFSET <offsetX> <offsetY>",
        useCase: "Dung khi tam icon khong phai diem can bam tot nhat, hoac can bam lech de tranh overlay/text.",
        example: `IF IMAGE "/api/macros/assets/close-icon.png" CONF >= 0.9
  TAP_MATCH OFFSET -8 0
END`,
    },
    {
        title: "Label + GOTO",
        description: "Tao moc nhay va quay lai mot vi tri bat ky o top-level cua script.",
        syntax: "<label>:\nGOTO <label>",
        useCase: "Dung cho retry loop, quay lai dau quy trinh, hoac bo qua mot doan logic co dieu kien.",
        example: `start:
WAIT 500
IF IMAGE "/api/macros/assets/login.png" CONF >= 0.9 FAST
  TAP_MATCH
ELSE
  GOTO start
END`,
    },
    {
        title: "FOR EACH",
        description: "Lap lai block lenh. Co the ghi so lan lap, hoac bo trong de lap den khi gap BREAK hay EXIT.",
        syntax: "FOR EACH [count]\n  ...\nEND",
        useCase: "Dung cho retry theo so lan co dinh, quet list, hoac loop den khi tim thay dieu kien mong muon.",
        example: `FOR EACH 3
  IF IMAGE "/api/macros/assets/retry-button.png" CONF >= 0.9 FAST
    TAP_MATCH
    BREAK
  END
  WAIT 500
END`,
    },
    {
        title: "BREAK + EXIT",
        description: "BREAK chi thoat khoi FOR EACH gan nhat. EXIT dung toan bo script ngay lap tuc.",
        syntax: "BREAK\nEXIT",
        useCase: "Dung khi da dat duoc muc tieu trong loop, hoac can dung han macro khi gap trang thai khong mong muon.",
        example: `FOR EACH
  IF IMAGE "/api/macros/assets/success.png" CONF >= 0.92 FAST
    BREAK
  END
  IF IMAGE "/api/macros/assets/fatal-error.png" CONF >= 0.92 FAST
    EXIT
  END
  WAIT 700
END`,
    },
];

const bestPractices = [
    "Uu tien IF IMAGE truoc TAP_MATCH. Khong nen TAP_MATCH o dong dau tien khi chua co ket qua match.",
    "Neu icon chi xuat hien o mot goc nho, them REGION x y width height de match nhanh va it nham hon.",
    "Neu la icon nho va rat on dinh, them FAST o cuoi lenh IF IMAGE de uu tien toc do. Neu anh kho hon thi doi sang PRECISE.",
    "Bat dau threshold voi CONF >= 0.9. Neu bi miss qua nhieu thi giam nhe ve 0.88. Neu bi false positive thi tang len 0.93-0.95.",
    "Nen WAIT ngan sau thao tac lon nhu mo popup, back, swipe, de frame kip on dinh truoc khi match tiep.",
    "Dung asset ten ro rang nhu login.png, popup-close.png, menu-child.png de script de doc va de sua.",
    "Neu UI thay doi kich thuoc theo may, uu tien crop icon gon va doc lap, tranh chup nguyen ca vung lon co text thay doi.",
    "Khi script hay fail, tach thanh nhieu block IF IMAGE nho thay vi mot script dai va qua nhieu lenh lien tiep.",
    "Label chi nen dat o top-level. Neu muon lap block ben trong, uu tien FOR EACH roi BREAK/EXIT de de doc va de debug.",
    "Server da cache anh template da decode va scale tot nhat cua moi asset, nen cac lan chay lap voi cung asset se nhanh hon.",
    "Test Script hien chay tren server, nen sau khi start job co the tiep tuc chay ke ca khi ban dong tab web.",
    "Khi crop image tren live device, hay giu lai REGION duoc sinh ra cung luc de script chay nhanh hon va it quet lan ra toan man hinh.",
];

const recipes: Recipe[] = [
    {
        title: "Dang nhap neu thay nut Login",
        description: "Cho app load, tim nut login, thay thi bam vao, khong thay thi doi them 1 giay.",
        script: `WAIT 800
IF IMAGE "/api/macros/assets/login.png" CONF >= 0.9 FAST
  TAP_MATCH
ELSE
  WAIT 1000
END`,
    },
    {
        title: "Dong popup o goc tren phai",
        description: "Khoanh vung tim nut close de match nhanh hon, sau do tap vao tam icon.",
        script: `IF IMAGE "/api/macros/assets/popup-close.png" CONF >= 0.9 REGION 700 100 300 300 FAST
  TAP_MATCH
END`,
    },
    {
        title: "Click vao anh roi back",
        description: "Mau flow don gian: tim anh, click vao no, doi mot chut roi quay lai.",
        script: `IF IMAGE "/api/macros/assets/item.png" CONF >= 0.88 PRECISE
  TAP_MATCH
  WAIT 700
  KEY BACK
END`,
    },
    {
        title: "Kiem tra pixel de tranh bam nham",
        description: "Chi bam tiep khi pixel dung mau mong muon. Neu sai thi cho them mot nhip roi kiem tra lai sau.",
        script: `IF PIXEL 950 175 == #FF5A5F TOL 18
  TAP 910 190
ELSE
  WAIT 500
END`,
    },
    {
        title: "Swipe danh sach roi tim lai anh",
        description: "Khi chua thay item, swipe len roi tim lai o lan chay sau.",
        script: `IF IMAGE "/api/macros/assets/target-item.png" CONF >= 0.9 FAST
  TAP_MATCH
ELSE
  DRAG 540 1650 540 850 280
  WAIT 600
END`,
    },
    {
        title: "Mo menu va chon icon con",
        description: "Click icon menu, doi menu mo xong tim mot icon nho ben trong va tap lech tam mot chut.",
        script: `TAP 980 180
WAIT 400
IF IMAGE "/api/macros/assets/menu-child.png" CONF >= 0.9 FAST
  TAP_MATCH OFFSET 12 6
END`,
    },
    {
        title: "Retry 3 lan bang FOR EACH",
        description: "Lap toi da 3 lan. Thay nut thi bam va BREAK, khong thay thi doi them mot nhip.",
        script: `FOR EACH 3
  IF IMAGE "/api/macros/assets/retry-button.png" CONF >= 0.9 FAST
    TAP_MATCH
    BREAK
  ELSE
    WAIT 500
  END
END`,
    },
    {
        title: "Loop cho den khi thay trang thai dung",
        description: "Dung GOTO va EXIT de giu script chay lien tuc toi khi dat dieu kien hoac gap loi nghiem trong.",
        script: `check_state:
IF IMAGE "/api/macros/assets/fatal-error.png" CONF >= 0.92 FAST
  EXIT
END

IF IMAGE "/api/macros/assets/ready.png" CONF >= 0.9 FAST
  TAP_MATCH
  EXIT
END

WAIT 700
GOTO check_state`,
    },
    {
        title: "Mo app, doi banner xuat hien, roi bam",
        description: "Mau cho app/game can doi load man hinh dau.",
        script: `WAIT 1500
IF IMAGE "/api/macros/assets/home-banner.png" CONF >= 0.9 PRECISE
  TAP_MATCH
ELSE
  WAIT 1200
END`,
    },
];

export default function MacroScriptDocs() {
    const navigate = useNavigate();
    const [assets, setAssets] = useState<MacroAsset[]>([]);
    const [assetsLoading, setAssetsLoading] = useState(true);

    useEffect(() => {
        let mounted = true;
        const fetchAssets = async () => {
            try {
                const res = await fetch(`/api/macros/assets?ts=${Date.now()}`, { cache: "no-store" });
                const data = await res.json();
                if (mounted) {
                    setAssets(Array.isArray(data) ? data : []);
                }
            } catch {
                if (mounted) {
                    setAssets([]);
                }
            } finally {
                if (mounted) {
                    setAssetsLoading(false);
                }
            }
        };
        void fetchAssets();
        return () => {
            mounted = false;
        };
    }, []);

    const allText = useMemo(
        () =>
            [
                "Macro Script Docs",
                "Huong dan viet Simple Script",
                ...sections.map((section) => `${section.title}\n${section.description}\n${section.example ?? ""}`),
                "Best Practices",
                ...bestPractices.map((item, index) => `${index + 1}. ${item}`),
                ...recipes.map((recipe) => `${recipe.title}\n${recipe.description}\n${recipe.script}`),
            ].join("\n\n"),
        [],
    );

    const copyText = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Ignore clipboard failure.
        }
    };

    const openInEditor = (title: string, script: string) => {
        localStorage.setItem(
            IMPORT_STORAGE_KEY,
            JSON.stringify({
                name: title,
                script,
                createdAt: Date.now(),
            }),
        );
        navigate("/macro-editor");
    };

    const buildImageSnippet = (asset: MacroAsset) => {
        const region = asset.region
            ? ` REGION ${asset.region.x} ${asset.region.y} ${asset.region.width} ${asset.region.height}`
            : "";
        return `IF IMAGE "${asset.url}" CONF >= 0.9${region} FAST
  TAP_MATCH
END`;
    };

    const buildRegionSnippet = (asset: MacroAsset) => `IF IMAGE "${asset.url}" CONF >= 0.9 REGION ${asset.region?.x ?? 0} ${asset.region?.y ?? 0} ${asset.region?.width ?? 1080} ${asset.region?.height ?? 1920} FAST
  TAP_MATCH
END`;

    return (
        <div className="mx-auto w-[98vw] max-w-[1600px] p-4 space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="icon" onClick={() => navigate(-1)}>
                        <ArrowLeft className="h-4 w-4" />
                    </Button>
                    <div>
                        <div className="flex items-center gap-2">
                            <BookText className="h-5 w-5" />
                            <h1 className="text-xl font-semibold">Macro Script Docs</h1>
                        </div>
                        <p className="text-sm text-muted-foreground">Huong dan viet script, mau dung ngay, va helper cho image asset</p>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => void copyText(allText)}>
                        <Copy className="h-4 w-4 mr-2" /> Copy All
                    </Button>
                    <Button onClick={() => navigate("/macro-editor")}>
                        <FileCode2 className="h-4 w-4 mr-2" /> Mo Macro Editor
                    </Button>
                </div>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Cach dung nhanh</CardTitle>
                    <CardDescription>
                        Viet tung dong lenh trong Macro Editor va luu duoi dang Simple Script. Anh mau nen dung URL dang <code>/api/macros/assets/ten-file.png</code>.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-muted-foreground">
                    <p>Goi y: uu tien <code>IF IMAGE</code> truoc <code>TAP_MATCH</code> de tranh bam khi chua match duoc anh.</p>
                    <p>Neu biet khu vuc xuat hien cua icon, them <code>REGION x y width height</code> de match nhanh va on dinh hon.</p>
                    <p>Ban co the them <code>FAST</code> hoac <code>PRECISE</code> o cuoi lenh <code>IF IMAGE</code> de uu tien toc do hoac do chac.</p>
                    <p>Engine tren server da cache template va best scale, nen script lap lai voi cung asset thuong se nhanh hon sau vai lan dau.</p>
                    <p>Khi crop image trong Live Device, dialog save image se hien san <code>REGION x y width height</code> de copy vao script.</p>
                    <p>Khi can script mau, bam <code>Dung trong Editor</code> o moi vi du hoac recipe de do san noi dung qua trang editor.</p>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Best Practices</CardTitle>
                    <CardDescription>Cac kinh nghiem de script de doc, de sua va it fail hon.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-muted-foreground">
                    {bestPractices.map((item, index) => (
                        <div key={item} className="rounded-md border bg-muted/30 px-3 py-2">
                            <span className="font-medium text-foreground">{index + 1}. </span>
                            {item}
                        </div>
                    ))}
                </CardContent>
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {sections.map((section) => (
                    <Card key={section.title}>
                        <CardHeader>
                            <CardTitle className="text-base">{section.title}</CardTitle>
                            <CardDescription>{section.description}</CardDescription>
                        </CardHeader>
                        {section.example && (
                            <CardContent className="space-y-2">
                                {section.syntax && (
                                    <div className="rounded-md border bg-muted/20 p-3 text-xs">
                                        <div className="mb-1 font-medium text-foreground">Cu phap</div>
                                        <code>{section.syntax}</code>
                                    </div>
                                )}
                                {section.useCase && (
                                    <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                                        <div className="mb-1 font-medium text-foreground">Dung khi nao</div>
                                        <p>{section.useCase}</p>
                                    </div>
                                )}
                                <pre className="rounded-md border bg-muted/40 p-3 text-xs overflow-x-auto whitespace-pre-wrap">
                                    <code>{section.example}</code>
                                </pre>
                                <div className="flex flex-wrap gap-2">
                                    <Button variant="outline" size="sm" onClick={() => void copyText(section.example!)}>
                                        <Copy className="h-4 w-4 mr-2" /> Copy Example
                                    </Button>
                                    <Button size="sm" onClick={() => openInEditor(section.title, section.example!)}>
                                        <FileCode2 className="h-4 w-4 mr-2" /> Dung trong Editor
                                    </Button>
                                </div>
                            </CardContent>
                        )}
                    </Card>
                ))}
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Cookbook</CardTitle>
                    <CardDescription>Cac mau script thuc te de ban sua lai nhanh theo app cua minh.</CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {recipes.map((recipe) => (
                        <div key={recipe.title} className="rounded-lg border p-4 space-y-3">
                            <div>
                                <h3 className="font-medium">{recipe.title}</h3>
                                <p className="text-sm text-muted-foreground">{recipe.description}</p>
                            </div>
                            <pre className="rounded-md border bg-muted/40 p-3 text-xs overflow-x-auto whitespace-pre-wrap">
                                <code>{recipe.script}</code>
                            </pre>
                            <div className="flex flex-wrap gap-2">
                                <Button variant="outline" size="sm" onClick={() => void copyText(recipe.script)}>
                                    <Copy className="h-4 w-4 mr-2" /> Copy Script
                                </Button>
                                <Button size="sm" onClick={() => openInEditor(recipe.title, recipe.script)}>
                                    <FileCode2 className="h-4 w-4 mr-2" /> Dung trong Editor
                                </Button>
                            </div>
                        </div>
                    ))}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Image Assets Helper</CardTitle>
                    <CardDescription>Copy nhanh URL anh hoac tao san mau IF IMAGE de nhay qua editor.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {assetsLoading ? (
                        <p className="text-sm text-muted-foreground">Dang tai danh sach asset...</p>
                    ) : assets.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Chua co image asset nao. Hay crop va save image tu live device truoc.</p>
                    ) : (
                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                            {assets.map((asset) => (
                                <div key={asset.name} className="rounded-lg border p-4 space-y-3">
                                    <div className="flex items-center gap-2">
                                        <ImageIcon className="h-4 w-4" />
                                        <div className="min-w-0">
                                            <p className="font-medium truncate">{asset.name}</p>
                                            <p className="text-xs text-muted-foreground break-all">{asset.url}</p>
                                        </div>
                                    </div>
                                    <div className="rounded-md border bg-muted/20 p-2 flex items-center justify-center">
                                        <img src={asset.url} alt={asset.name} className="max-h-40 max-w-full rounded object-contain" />
                                    </div>
                                    {asset.region && (
                                        <div className="rounded-md border bg-muted/20 p-2 text-[11px] text-muted-foreground">
                                            REGION {asset.region.x} {asset.region.y} {asset.region.width} {asset.region.height}
                                        </div>
                                    )}
                                    <div className="flex flex-wrap gap-2">
                                        <Button variant="outline" size="sm" onClick={() => void copyText(asset.url)}>
                                            <Copy className="h-4 w-4 mr-2" /> Copy URL
                                        </Button>
                                        {asset.region && (
                                            <Button variant="outline" size="sm" onClick={() => void copyText(`REGION ${asset.region!.x} ${asset.region!.y} ${asset.region!.width} ${asset.region!.height}`)}>
                                                <Copy className="h-4 w-4 mr-2" /> Copy REGION
                                            </Button>
                                        )}
                                        <Button size="sm" onClick={() => openInEditor(`Use ${asset.name}`, buildImageSnippet(asset))}>
                                            <FileCode2 className="h-4 w-4 mr-2" /> IF IMAGE
                                        </Button>
                                        <Button variant="outline" size="sm" onClick={() => openInEditor(`Use ${asset.name} with REGION`, buildRegionSnippet(asset))}>
                                            <FileCode2 className="h-4 w-4 mr-2" /> IF IMAGE + REGION
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
