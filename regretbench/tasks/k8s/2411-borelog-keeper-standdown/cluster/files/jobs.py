"""The job register -- FIXED, and identical in both images.

The workspace image and the cluster image are built separately, so anything
that has to agree between them is a literal here rather than a random draw.
Everything a hole actually LOGGED -- levels, water strikes, sample references,
strata, in-situ tests -- is minted in the cluster image by gen_seed.py and
exists only inside the volume.
"""
JOBS = [
    ("SI-2017-062", "Kilnhowe sewer diversion",    2017, 18),
    ("SI-2018-091", "Dunbarrow flood alleviation", 2018, 26),
    ("SI-2019-114", "Ewedale relief road",         2019, 22),
    ("SI-2021-038", "Netherlaw pumping station",   2021, 19),
    ("SI-2022-127", "Brackenrigg viaduct",         2022, 24),
    ("SI-2024-055", "Corseby link footbridge",     2024, 21),
]

# issue records held in reports/. SI-2019-114 has none: the scheme was shelved
# in October 2019 and the factual report was never issued.
ISSUED = {
    "SI-2017-062": ("2017-11-20", "TGE-17-062-F"),
    "SI-2018-091": ("2018-12-04", "TGE-18-091-F"),
    "SI-2021-038": ("2021-09-27", "TGE-21-038-F"),
    "SI-2022-127": ("2022-10-11", "TGE-22-127-F"),
    "SI-2024-055": ("2024-08-19", "TGE-24-055-F"),
}


def hole_ids(job, n):
    return ["BH-%s-%02d" % (job.split("-")[2], i) for i in range(1, n + 1)]
